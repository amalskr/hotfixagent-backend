# HotFixAgent

**Telemetry-driven agentic repair of Android production crashes.** HotFixAgent
turns a Firebase Crashlytics crash alert into a *human-reviewed pull request*,
automatically, in minutes. It parses the crash, assigns a confidence label, runs
an LLM coding agent that locates the fault and proposes a minimal fix, builds and
tests it, opens an **unmerged** pull request, and notifies your team of the
outcome. A human always reviews and merges.

---

## 1. What it does (overview)

```
 Production crash ─▶ Crashlytics ─▶ Cloud Function ─▶ GitHub Action (LLM agent) ─▶ Pull Request ─▶ Human review & merge
   (user device)      new / regression   parse · confidence      locate → fix →        (unmerged)        (never auto-merged)
                          alert           label · dispatch        build → test
                                              │                       │
                                       Slack: "attempting"     Slack: outcome (ready / draft / could-not-fix)
                                                                        │
                              ◀──────── regression feedback loop: a resolved issue that recurs re-triggers the pipeline
```

Key design choices:
- **Attempt every crash, don't gate.** Triage produces a *confidence label*
  (`auto` = high / `needs_human` = low), not a yes/no gate. Every crash is
  attempted once; the label tells reviewers which PRs to scrutinise.
- **Human-in-the-loop.** The agent never merges. Every fix is a PR a human approves.
- **Two notifications.** One when a fix is attempted, one with the outcome — so a
  crash the agent can't fix is surfaced ("needs human attention"), never lost.
- **Regression loop.** If a resolved issue recurs, Crashlytics re-triggers the
  pipeline, so an inadequate fix is revisited automatically.
- **Conversational revision.** A reviewer can mention the agent in a PR comment
  to request a revised fix on the same branch (no code edit needed).

## 2. Components

| Part | Where | What |
|---|---|---|
| `backend/src/index.ts` | Firebase Cloud Functions | 3 functions: `hotfixOnFatalCrash`, `hotfixOnRegression`, `hotfixStatusCallback` |
| `backend/src/stackTraceParser.ts` | (pure logic) | parse trace → culprit frame + confidence label |
| `backend/src/hotfix.config.ts` | **single source of truth** | all app-specific backend settings |
| `.github/workflows/hotfix-agent.yml` | target app repo | runs the LLM agent, opens PR, calls status callback |
| `.github/workflows/hotfix-revise.yml` | target app repo | reviewer-driven revision via PR mention |

## 2b. Two repositories — what goes where

HotFixAgent spans **two separate Git repos**. Putting a file in the wrong one is
the most common setup mistake, so be explicit:

```
┌─ BACKEND repo  (e.g. hotfixagent-backend) ─────────────┐
│  Cloud Functions — deployed to Firebase, not GitHub-run │
│  src/index.ts                                           │
│  src/hotfix.config.ts        ← edit per app             │
│  src/githubGuard.ts                                     │
│  src/stackTraceParser.ts                                │
│  package.json, tsconfig.json …                          │
│  (NO workflows here)                                    │
└─────────────────────────────────────────────────────────┘
                    │  repository_dispatch  (event_type = dispatchEventType)
                    ▼
┌─ MOBILE APP repo  (e.g. the Ceylon Calendar app) ──────┐
│  app/ …  (Kotlin / Gradle source the agent fixes)       │
│  .github/workflows/hotfix-agent.yml    ← HERE           │
│  .github/workflows/hotfix-revise.yml   ← HERE           │
└─────────────────────────────────────────────────────────┘
```

The Cloud Function does not run on GitHub — it runs on **Firebase** and fires a
`repository_dispatch` at the **app repo**, where the workflow runs the agent,
edits the Kotlin source, and opens the PR. So `config.githubRepo` is the **app
repo** (`owner/app-repo`), never the backend repo.

| File / setting | Goes in |
|---|---|
| `src/*.ts` (index, hotfix.config, githubGuard, stackTraceParser) | **Backend** repo |
| `package.json`, `tsconfig.json` | **Backend** repo |
| Firebase secrets: `GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, `CALLBACK_TOKEN` | Firebase (set via CLI) |
| `.github/workflows/hotfix-agent.yml` | **Mobile app** repo |
| `.github/workflows/hotfix-revise.yml` | **Mobile app** repo |
| GitHub secrets: `ANTHROPIC_API_KEY`, `HOTFIX_CALLBACK_URL`, `CALLBACK_TOKEN` | **Mobile app** repo |
| GitHub variables: `HOTFIX_BRANCH`, `HOTFIX_PR_BASE`, `HOTFIX_TRIGGER_PHRASE` … | **Mobile app** repo |

> The `GITHUB_TOKEN` Firebase secret must reach the **app** repo and have:
> **Contents: R/W** (dispatch), **Pull requests: R/W** (loop-guard PR check),
> **Actions: R/W**, **Metadata: R**. A fine-grained token scoped to the app repo,
> or a classic PAT with `repo` + `workflow`, both work. If the logs show
> `PR check failed (HTTP 403)`, the token is missing **Pull requests** read.
> Verify with:
> ```bash
> curl -H "Authorization: Bearer YOUR_TOKEN" -H "Accept: application/vnd.github+json" >   "https://api.github.com/repos/OWNER/APP_REPO/pulls?state=all&per_page=1"
> ```
> (See DEPLOY-CHECKLIST.md → Appendix A for step-by-step token creation.)

## 3. Prerequisites

- An Android app using **Firebase Crashlytics** (Blaze plan — Crashlytics alert
  triggers need it), with the app source in a **GitHub** repo.
- **Anthropic API key**, a **GitHub token** (repo + workflow scope), and a
  **Slack incoming webhook** (optional but recommended).
- `firebase-tools` and Node 22 locally.
- **Release-build note:** enable R8/ProGuard **mapping file upload** and retain
  source/line attributes, or release crashes arrive obfuscated and the agent
  can't localise them.

---

## 4. How to set up (complete step-by-step)

This is the full first-time setup. Do the **backend** (Cloud Functions) first,
then the **mobile app repo**. A copy-paste checklist is at the end (§4h).

> Reminder (see §2b): backend `src/*` lives in the **backend repo**; the two
> workflow files live in the **mobile app repo**. `config.githubRepo` is the
> **app** repo.

### 4a. Gather the values you'll need

| Value | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys |
| `GITHUB_TOKEN` | GitHub token with repo access — see **Appendix A** (needs Pull requests: R/W) |
| `SLACK_WEBHOOK_URL` | Slack → see step 4f below |
| `CALLBACK_TOKEN` | generate yourself: `openssl rand -hex 32` |
| Slack member IDs | Slack profile → ⋮ → "Copy member ID" (for `slackMentionUserIds`) |

### 4b. Set up the Firebase project

1. Create / pick a project at console.firebase.google.com.
2. **Upgrade to the Blaze (pay-as-you-go) plan** — Crashlytics alert triggers
   (`onNewFatalIssuePublished` / `onRegressionAlertPublished`) require Blaze.
3. Add your Android app and make sure **Crashlytics** is enabled and receiving
   crashes (the app must report at least once).
4. Install the CLI and log in:
   ```bash
   npm install -g firebase-tools
   firebase login
   ```

### 4c. Configure and install the backend

```bash
cd backend
npm install
firebase use <your-firebase-project-id>     # or set it in .firebaserc
```
Edit **`src/hotfix.config.ts`** — the only file you change per app:
```ts
appPackages:       ["com.yourcompany.yourapp"],
githubRepo:        "yourorg/your-app-repo",        // the APP repo (not the backend)
firebaseProjectId: "your-firebase-project-id",
crashlyticsAppId:  "android:com.yourcompany.yourapp",
region:            "asia-southeast1",              // your functions region
targetBranch:      "main",
slackMentionUserIds: ["U01ABC2DEF"],               // who to @mention
dispatchMode:      "all",                          // high-traffic app? start "notify-only"
```

### 4d. Build (always before deploy)

```bash
rm -rf lib/        # clean, so stale output can't be redeployed
npm run build      # tsc — must finish with no errors
```
Sanity check the compiled output contains the latest code:
```bash
grep -c "parseAlertTitle" lib/index.js     # expect 2 (not 0)
```
If it's `0`, the build didn't pick up the new source — re-check `src/` and that
`npm run build` printed no errors.

### 4e. Set the three Firebase secrets (terminal)

Secrets are **not** stored in code or a `.env` file at runtime — they live in
Firebase's secret store. Set each with the CLI; it prompts you to paste the value:

```bash
firebase functions:secrets:set GITHUB_TOKEN        # paste the GitHub token (Appendix A)
firebase functions:secrets:set SLACK_WEBHOOK_URL   # paste the Slack webhook URL (step 4f)
firebase functions:secrets:set CALLBACK_TOKEN      # paste: openssl rand -hex 32
```
Verify any value later with:
```bash
firebase functions:secrets:access CALLBACK_TOKEN
```
> Keep the `CALLBACK_TOKEN` value — you set the **same** value as a GitHub secret
> in step 4g, so the workflow can call back into the function.

### 4f. Get the Slack webhook URL (and where it goes)

The webhook is **where** crash messages are posted; `slackMentionUserIds` is
**who** gets pinged inside that message.

1. Go to api.slack.com/apps → **Create New App** (or pick an existing one) → *From scratch*.
2. **Incoming Webhooks** → toggle **On** → **Add New Webhook to Workspace**.
3. Pick the channel → **Allow** → copy the URL
   (`https://hooks.slack.com/services/T…/B…/…`).
4. That URL is your **`SLACK_WEBHOOK_URL`** — you paste it in step 4e
   (`firebase functions:secrets:set SLACK_WEBHOOK_URL`). It is **not** put in
   `hotfix.config.ts`; only the secret store holds it.

### 4g. Deploy the functions and grab the callback URL

```bash
npm run deploy
# (equivalently: firebase deploy --only functions --force)
```
- If it prints `Skipped (No changes detected)` but you changed code, force it:
  ```bash
  rm -rf lib/ && npm run build
  firebase deploy --only functions --force
  ```
- From the output, copy the **`hotfixStatusCallback`** URL:
  ```
  https://<region>-<project>.cloudfunctions.net/hotfixStatusCallback
  ```
  (it may also appear as a `…run.app` URL). This is your `HOTFIX_CALLBACK_URL`.

### 4h. Set up the mobile app repo (GitHub)

1. Copy `.github/workflows/hotfix-agent.yml` and `hotfix-revise.yml` into the
   **app repo**, commit, and push.
2. Repo → **Settings → Secrets and variables → Actions → Secrets** → add:
    - `ANTHROPIC_API_KEY`
    - `HOTFIX_CALLBACK_URL` = the URL from step 4g
    - `CALLBACK_TOKEN` = the **same** value you set in Firebase (step 4e)
3. (Optional) **Variables** tab — override CI defaults:
   `HOTFIX_BRANCH`, `HOTFIX_PR_BASE`, `HOTFIX_BUILD_CMD`, `HOTFIX_TEST_CMD`,
   `HOTFIX_JAVA_VERSION`, `HOTFIX_MAX_TURNS`, `HOTFIX_TRIGGER_PHRASE`.
4. **Settings → Actions → General → Workflow permissions** → enable
   **Read and write** + **Allow GitHub Actions to create and approve pull requests**.
5. (Recommended) Add **branch protection** on `main` so nothing auto-merges.

### 4i. Verify end-to-end

1. **Manual run (no crash needed):** app repo → Actions → "HotFix Agent" →
   *Run workflow* → fill the exception fields → expect a PR + a Slack outcome
   message in a few minutes (this proves `HOTFIX_CALLBACK_URL` + `CALLBACK_TOKEN`).
2. **Real crash:** trigger a crash, then **restart the app** (Crashlytics uploads
   on next launch) → Slack "attempting" → agent → PR → Slack "PR ready".
3. **Check logs:**
   ```bash
   firebase functions:log --only hotfixOnFatalCrash | grep "Triage result"
   ```
   Expect a real `culprit` and `confidence`. If you see
   `PR check failed (HTTP 403)`, the `GITHUB_TOKEN` lacks **Pull requests** read
   (Appendix A).

### 4j. Release-build note

Enable **R8/ProGuard mapping upload** and keep `-keepattributes SourceFile,LineNumberTable`
(and do **not** use `-renamesourcefileattribute SourceFile`, or real file names are
lost). Otherwise release crashes arrive obfuscated. The parser still copes with
obfuscated frames (`treatObfuscatedFramesAsApp`), but deobfuscation gives better
locations.

### ✅ Setup checklist

Backend (backend repo / Firebase):
- [ ] Firebase project on **Blaze**, Crashlytics enabled and reporting
- [ ] `firebase-tools` installed, `firebase login`, `firebase use <project>`
- [ ] `npm install` in `backend/`
- [ ] `src/hotfix.config.ts` filled in (packages, repo, project, region, branch, mentions, dispatchMode)
- [ ] `rm -rf lib/ && npm run build` → no errors → `grep -c parseAlertTitle lib/index.js` = 2
- [ ] `firebase functions:secrets:set GITHUB_TOKEN` (token from Appendix A, Pull requests R/W)
- [ ] `firebase functions:secrets:set SLACK_WEBHOOK_URL` (step 4f)
- [ ] `firebase functions:secrets:set CALLBACK_TOKEN` (`openssl rand -hex 32`)
- [ ] `npm run deploy` → copy the `hotfixStatusCallback` URL

Mobile app repo (GitHub):
- [ ] `hotfix-agent.yml` + `hotfix-revise.yml` in `.github/workflows/`
- [ ] Secret `ANTHROPIC_API_KEY`
- [ ] Secret `HOTFIX_CALLBACK_URL` (from deploy output)
- [ ] Secret `CALLBACK_TOKEN` (**same** as Firebase)
- [ ] (optional) Variables: `HOTFIX_BRANCH`, `HOTFIX_PR_BASE`, …
- [ ] Actions: Read/write + "create PRs" enabled
- [ ] Branch protection on `main`

Verify:
- [ ] Manual workflow run → PR + Slack outcome
- [ ] Real crash → restart app → Slack "attempting" → PR → "PR ready"
- [ ] Logs show a real culprit + confidence; no `HTTP 403`


## 5. Deploy to a *new* app — change in TWO single places

You only touch **one file** on the backend and **one settings page** on CI.

### A. Backend → edit only `backend/src/hotfix.config.ts`
```ts
appPackages:       ["com.yourcompany.yourapp"],   // your package prefix
githubRepo:        "yourorg/yourapp",             // owner/repo
firebaseProjectId: "your-firebase-project",
crashlyticsAppId:  "android:com.yourcompany.yourapp",
region:            "asia-southeast1",             // your functions region
targetBranch:      "main",                        // branch the live app ships from
// (optionally tune autoFixableTypes / notAutoFixableTypes for this app)
```
Then `npm run deploy`, and set the three Firebase secrets for the new project.

### B. CI → the new repo's "Variables" page (one place, all optional)
Settings → Secrets and variables → Actions → **Variables**:

| Variable | Default | Purpose |
|---|---|---|
| `HOTFIX_BRANCH` | `main` | branch the fix is forked from (never edited directly) |
| `HOTFIX_PR_BASE` | `main` | PR base; a human can re-target to e.g. `development` |
| `HOTFIX_BUILD_CMD` | `./gradlew assembleDebug` | build command |
| `HOTFIX_TEST_CMD` | `./gradlew testDebugUnitTest` | test command |
| `HOTFIX_JAVA_VERSION` | `17` | JDK version |
| `HOTFIX_MAX_TURNS` | `40` | agent iteration budget (cost control) |
| `HOTFIX_TRIGGER_PHRASE` | `@claude` | mention that triggers a PR revision |

Plus the new repo's **Secrets**: `ANTHROPIC_API_KEY`, `HOTFIX_CALLBACK_URL`,
`CALLBACK_TOKEN`. That's it — no source edits in `index.ts`, the parser, or the
workflows.

> Because confidence labelling depends on `appPackages` (app-owned vs framework),
> setting the right package prefix is the most important change for a new app.

---

## 6. Configuration reference

**Backend (`hotfix.config.ts`)** — `appPackages`, `githubRepo`, `firebaseProjectId`,
`crashlyticsAppId`, `region`, `targetBranch`, `dispatchEventType`, `functionMemory`,
`autoFixableTypes`, `notAutoFixableTypes`.

**CI (repo Variables)** — see the table in §5B.

**Secrets** — see `.env.example`.

> `dispatchEventType` (default `hotfix-crash`) must match the
> `repository_dispatch: types:` in `hotfix-agent.yml`. Change both if you rename it.

---

## 7. How it works (flow detail)

1. Crashlytics fires `onNewFatalIssuePublished` or `onRegressionAlertPublished`.
2. The Cloud Function parses the alert, classifies frames as app vs framework
   (via `appPackages`), picks the culprit frame, and computes a confidence label.
   Fixability ≈ *type localisability × culprit ownership × root-cause recoverability*
   — so the type alone never decides it.
3. It posts a Slack "attempting" message and fires a `repository_dispatch` to the
   app repo with the crash details + confidence.
4. `hotfix-agent.yml` checks out the target branch and runs the Claude Code agent
   (read/search/edit/build/test, bounded turns, single attempt). The agent finds
   the fault, applies a minimal root-cause fix on a new branch
   `agent/<exception>-<method>-<issueId>` (it never edits the main branch), builds,
   tests, and opens a PR (draft if it isn't confident) with base `HOTFIX_PR_BASE`.
   It never merges — a human decides whether to merge or re-target.
5. The workflow's final step calls `hotfixStatusCallback`, which posts the
   outcome to Slack (ready / draft / could-not-fix).
6. If a merged fix later regresses, the regression alert re-runs the pipeline.

## 7b. Loop guard & Slack behaviour

The loop guard uses **GitHub itself** as the state store — no database, no extra
service, no extra cost. Before dispatching, the Cloud Function checks for an
existing hotfix PR (`head = hotfix/<issueId>`):

- **Open PR exists** → the crash is already being handled → **no duplicate Slack,
  no second agent run**.
- **No PR yet** → first occurrence → one Slack message (@mentioning
  `slackMentionUserIds`) + one agent run.
- **Only closed/merged PRs, count ≥ `maxAttemptsPerIssue`** → it keeps recurring →
  one "needs a human" Slack message, no further dispatch.
- **Closed PRs below the cap** → genuine regression → re-attempt.

A GitHub Actions **`concurrency`** group (`hotfix-<issueId>`) in the workflow adds
the atomic guarantee: two events for the same issue at the same instant cannot
start parallel runs.

This is the main cost control: in production the same crash recurs, so the guard
avoids re-running (and re-paying for) the agent on an issue already in flight.

> **Token caching:** the repair agent runs via `claude-code-action` (Claude Code),
> which caches the stable prompt prefix automatically within each run — nothing to
> configure. The Cloud Function makes no LLM calls, so it has no token cost. The
> loop guard above is the real saving.

## 8. Safety & cost notes

- The agent has **no merge rights**; PRs are human-reviewed.
- Prompt forbids swallowing `try/catch` and catching coroutine cancellation.
- **Cost:** every crash runs the agent. To control spend, tune `HOTFIX_MAX_TURNS`,
  consider skipping the agent for `needs_human` types, and de-duplicate recurring
  crashes (a persistent attempt counter is a known extension).
- **Secrets** live only in Firebase/GitHub secret stores — never in `hotfix.config.ts`.

## 9. File layout (per repo)

**Backend repo** (Cloud Functions → Firebase):
```
src/
  hotfix.config.ts      ← the only file you edit per app
  index.ts              ← Cloud Functions (no app-specifics)
  githubGuard.ts        ← GitHub-native loop guard (no DB)
  stackTraceParser.ts   ← pure parser (no app-specifics)
package.json            ← deps: firebase-functions  (no firebase-admin needed)
tsconfig.json, …        ← your existing build config
```

**Mobile app repo** (the app the agent fixes):
```
.github/workflows/
  hotfix-agent.yml      ← runs the agent, opens the PR (+ concurrency guard)
  hotfix-revise.yml     ← reviewer-driven revision via PR mention
app/ …                  ← your Kotlin/Gradle source
```

> This `portable/` bundle ships both sets together for convenience. When
> installing, copy `backend/src/*` into the **backend** repo and
> `.github/workflows/*` into the **app** repo (see §2b).