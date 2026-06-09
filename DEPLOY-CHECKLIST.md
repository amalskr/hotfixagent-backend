# HotFixAgent — Deployment Checklist

Follow top to bottom. Boxes you tick once per app. The single most important
matching rule: **`CALLBACK_TOKEN` must be byte-for-byte identical on Firebase and
on GitHub** — that is what lets the workflow post the outcome back to Slack.

---

## 0. Keys you need — where each comes from, where it goes

| Key | Get it from | Stored as |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys | **GitHub** repo secret |
| `GITHUB_TOKEN` | GitHub → Settings → Developer settings → Personal access tokens | **Firebase** secret |
| `SLACK_WEBHOOK_URL` | Slack → your app → Incoming Webhooks | **Firebase** secret |
| `CALLBACK_TOKEN` | generate: `openssl rand -hex 32` | **BOTH** Firebase secret **and** GitHub repo secret (same value) |
| `HOTFIX_CALLBACK_URL` | printed after you deploy the function (Part 4) | **GitHub** repo secret |

> `GITHUB_TOKEN` scope: classic PAT with **`repo`** + **`workflow`**, OR a fine-grained
> token scoped to the repo with **Contents: read/write**, **Pull requests: read**,
> and **Metadata: read** (Contents+dispatch to trigger the workflow; Pull requests
> read so the loop guard can check for an existing PR).

---

## 1. Firebase project setup

- [ ] Create / pick a Firebase project (console.firebase.google.com).
- [ ] **Upgrade to the Blaze plan** — Crashlytics alert triggers
      (`onNewFatalIssuePublished`, `onRegressionAlertPublished`) are v2 Alerts
      functions and require Blaze.
- [ ] Add your Android app to the project; download `google-services.json` into
      the app module (if not already).
- [ ] Enable **Crashlytics** (Firebase console → Crashlytics) and confirm the app
      reports at least one crash so the integration is live.
- [ ] Install tooling locally: `npm i -g firebase-tools` then `firebase login`.

## 2. Backend config + install

- [ ] `cd backend && npm install`
- [ ] Edit **`src/hotfix.config.ts`** (the only file to change per app):
      ```ts
      appPackages:       ["com.yourcompany.yourapp"],
      githubRepo:        "yourorg/yourapp",
      firebaseProjectId: "your-firebase-project-id",
      crashlyticsAppId:  "android:com.yourcompany.yourapp",
      region:            "asia-southeast1",   // your functions region
      targetBranch:      "main",
      slackMentionUserIds: ["U01ABC2DEF"],  // Slack member IDs to @mention (optional)
      maxAttemptsPerIssue: 3,                // loop-guard attempt cap
      ```
- [ ] `firebase use your-firebase-project-id` (or set it in `.firebaserc`).

## 3. Set the Firebase secrets (backend)

Run each; paste the value when prompted (values are NOT stored in code):

```bash
firebase functions:secrets:set GITHUB_TOKEN
firebase functions:secrets:set SLACK_WEBHOOK_URL
firebase functions:secrets:set CALLBACK_TOKEN     # paste: openssl rand -hex 32
```

- [ ] `GITHUB_TOKEN` set
- [ ] `SLACK_WEBHOOK_URL` set
- [ ] `CALLBACK_TOKEN` set  ← **remember this value; you reuse it on GitHub**

> Verify any time with `firebase functions:secrets:access CALLBACK_TOKEN`.

## 4. Deploy the functions + grab the callback URL

```bash
npm run build
npm run deploy        # deploys hotfixOnFatalCrash, hotfixOnRegression, hotfixStatusCallback
```

- [ ] Deploy succeeded ("Deploy complete!").
- [ ] Copy the **`hotfixStatusCallback`** HTTPS URL from the output. It looks like:
      ```
      https://<region>-<project-id>.cloudfunctions.net/hotfixStatusCallback
      ```
      This is your `HOTFIX_CALLBACK_URL`.

## 5. GitHub — workflows, secrets, variables (in the target APP repo)

### 5a. Add the workflows
- [ ] Copy `.github/workflows/hotfix-agent.yml` and `hotfix-revise.yml` into the
      app repo, commit, and push to the default branch.

### 5b. Add repo Secrets
Repo → **Settings → Secrets and variables → Actions → Secrets → New repository secret**:

- [ ] `ANTHROPIC_API_KEY` = your Claude API key
- [ ] `HOTFIX_CALLBACK_URL` = the URL from Part 4
- [ ] `CALLBACK_TOKEN` = **the exact same value** you set in Firebase (Part 3)

### 5c. (Optional) Add repo Variables — override CI defaults
Same page → **Variables** tab. All optional (defaults shown):

- [ ] `HOTFIX_BRANCH` (default `main`) — branch the fix is forked from
- [ ] `HOTFIX_PR_BASE` (default `main`) — PR base; human can re-target to `development`
- [ ] `HOTFIX_BUILD_CMD` (default `./gradlew assembleDebug`)
- [ ] `HOTFIX_TEST_CMD` (default `./gradlew testDebugUnitTest`)
- [ ] `HOTFIX_JAVA_VERSION` (default `17`)
- [ ] `HOTFIX_MAX_TURNS` (default `40`)
- [ ] `HOTFIX_TRIGGER_PHRASE` (default `@claude`; set `@fixagent` to change the mention)

### 5d. Allow Actions to open PRs
- [ ] Repo → Settings → Actions → General → Workflow permissions →
      **Read and write permissions** + **Allow GitHub Actions to create and
      approve pull requests** = enabled.

## 6. Slack (optional but recommended)

- [ ] Create a Slack app → enable **Incoming Webhooks** → add to your channel →
      copy the webhook URL → that is `SLACK_WEBHOOK_URL` (Part 3).

## 7. Verify the wiring

### 7a. Manual workflow test (no real crash needed)
- [ ] App repo → **Actions → "HotFix Agent" → Run workflow**, fill the exception
      fields (e.g. `java.lang.ArithmeticException`, a real class/method) → Run.
- [ ] A `hotfix/<issueId>` branch + **Pull Request** should appear in a few minutes.
- [ ] A Slack **outcome** message (ready / draft / could-not-fix) should arrive —
      this proves `HOTFIX_CALLBACK_URL` + `CALLBACK_TOKEN` match.

### 7b. Real end-to-end test
- [ ] Trigger a real crash in the app → let Crashlytics report it.
- [ ] Slack: "attempting" message → then "outcome" message.
- [ ] Review the PR; merge if good.

### 7c. Revision test
- [ ] On an open hotfix PR, comment the trigger phrase (default `@claude`) asking
      for a change → the agent pushes a revision to the same branch.

## 8. Release-build note (don't skip)

- [ ] Enable **R8/ProGuard mapping file upload** and retain source/line
      attributes for release builds — otherwise production crashes arrive
      obfuscated and the agent can't localise them. (Debug builds are fine as-is.)

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Workflow runs but **no Slack outcome** | `HOTFIX_CALLBACK_URL` wrong, or `CALLBACK_TOKEN` differs between Firebase and GitHub |
| `401 unauthorized` in function logs | `CALLBACK_TOKEN` mismatch |
| Crash fires but **no workflow** | `GITHUB_TOKEN` scope too low, or `githubRepo` / `dispatchEventType` mismatch (must equal `repository_dispatch: types:`) |
| Agent can't find the file | wrong `appPackages` prefix, or release build obfuscated (Part 8) |
| Function won't deploy (Crashlytics trigger) | project not on **Blaze** plan |
| PR not created | Actions "create PRs" permission disabled (Part 5d) |

Check function logs: `firebase functions:log` · Check secret value: `firebase functions:secrets:access NAME`.

---

## One-glance summary

```
Firebase secrets:   GITHUB_TOKEN · SLACK_WEBHOOK_URL · CALLBACK_TOKEN
GitHub secrets:     ANTHROPIC_API_KEY · HOTFIX_CALLBACK_URL · CALLBACK_TOKEN(same)
GitHub variables:   HOTFIX_BRANCH/BUILD_CMD/TEST_CMD/JAVA_VERSION/MAX_TURNS/TRIGGER_PHRASE (optional)
Edit per app:       backend/src/hotfix.config.ts  (+ repo Variables)
Match rule:         CALLBACK_TOKEN identical on Firebase & GitHub
```
