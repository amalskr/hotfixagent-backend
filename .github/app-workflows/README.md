# Workflow templates for the **mobile app** repo

These two files do **not** run in this backend repo — they are the source copies
of the workflows that live in the app repo (`config.githubRepo`, currently
`amalskr/HotfixAgent`). They are kept here so the agent prompt and the backend
config stay reviewable together.

They sit in `.github/app-workflows/` (not `.github/workflows/`) on purpose:
`hotfix-revise.yml` triggers on `issue_comment`, so if it lived in
`.github/workflows/` here it would fire on comments in *this* repo.

## Install / update

```bash
# from the app repo checkout
cp path/to/hotfixagent-backend/.github/app-workflows/hotfix-agent.yml   .github/workflows/
cp path/to/hotfixagent-backend/.github/app-workflows/hotfix-revise.yml  .github/workflows/
git add .github/workflows && git commit -m "hotfix agent: Gemini fallback" && git push
```

## LLM providers

Claude is the primary agent; **Gemini is the fallback** for when the Anthropic
API is over quota. Each run:

1. pre-checks the Anthropic API with a 1-token request;
2. `429` / `529` / `credit balance too low` / rejected key → runs on Gemini;
3. otherwise runs on Claude.

If the chosen provider fails *without opening a PR or pushing the branch*, the
crash is retried once on the other provider (Gemini → Claude only when a fresh
pre-check returns `200`). A run bounces at most once, and a final guard fails the
run when no PR exists at the end — so "all providers failed" never shows green.

Required app-repo secrets: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (either one may
be omitted — with only one key set, that provider is always used).

Setting the provider (first match wins):

| Where | Applies to |
|---|---|
| `llmProvider` in the backend's `src/hotfix.config.ts` | crash-triggered runs |
| Actions → HotFix Agent → Run workflow → **LLM provider** | that one run |
| `HOTFIX_LLM` repo variable | manual runs left on `default`, and PR revisions |
| `llm=gemini` in a PR comment | that one revision |

Pinning `claude` or `gemini` means **no pre-check and no cross-provider retry** —
that LLM every time, and a missing key fails the run instead of switching. Only
`auto` probes and fails over.

`HOTFIX_GEMINI_MODEL` pins the Gemini model. Worth setting explicitly — left
unset, the fallback follows whatever the Gemini CLI currently defaults to, and
free-tier daily quotas are per-model, so the default can be exhausted while
another model still has budget.
