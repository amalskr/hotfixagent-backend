# Workflow templates for the **mobile app** repo

These two files do **not** run in this backend repo — they are the source copies
of the workflows that live in the app repo (`config.githubRepo`, currently
`amalskr/HotfixAgent`). They are kept here so the agent prompt stays reviewable
alongside the backend.

They sit in `.github/app-workflows/` (not `.github/workflows/`) on purpose:
`hotfix-revise.yml` triggers on `issue_comment`, so if it lived in
`.github/workflows/` here it would fire on comments in *this* repo.

## Install / update

```bash
# from the app repo checkout
cp path/to/hotfixagent-backend/.github/app-workflows/hotfix-agent.yml   .github/workflows/
cp path/to/hotfixagent-backend/.github/app-workflows/hotfix-revise.yml  .github/workflows/
git add .github/workflows && git commit -m "update hotfix workflows" && git push
```

## Switching the LLM

The agent runs on **Claude**. Gemini is a manual alternative — no automatic
switching, no pre-check, no failover. One provider per run.

| To switch | Do this |
|---|---|
| All runs | set repo variable `HOTFIX_LLM` to `gemini` (`claude` to undo) |
| One manual run | Actions → HotFix Agent → Run workflow → **LLM** = `gemini` |
| One PR revision | write `llm=gemini` in the `@claude` comment |

Needs the `GEMINI_API_KEY` secret. `HOTFIX_GEMINI_MODEL` optionally pins the
model. Switching is purely CI-side — the backend never chooses the provider, so
no redeploy is involved.

Two Gemini-specific details, both easy to trip over:

- `GEMINI_CLI_TRUST_WORKSPACE: "true"` is **required** — a CI checkout is never a
  "trusted folder", and without it the CLI downgrades `--yolo` to interactive
  approval and exits 1 after ~2 seconds.
- The Gemini CLI has no built-in git/PR plumbing, so its prompt spells out the
  `git` + `gh pr create` steps that `claude-code-action` handles on its own.

⚠ A **free-tier** Gemini key caps at 20 requests/day, which one repair run spends
in its first few turns. Enable billing on the key's project before relying on it.
