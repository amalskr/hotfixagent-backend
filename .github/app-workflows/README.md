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
3. otherwise runs on Claude, and if Claude *fails without opening a PR*, retries
   the same crash once on Gemini.

Required app-repo secrets: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (either one may
be omitted — with only one key set, that provider is always used).

Forcing a provider:

| Where | How |
|---|---|
| Backend (all crashes) | `llmProvider: "gemini"` in `src/hotfix.config.ts` |
| One manual run | Actions → HotFix Agent → Run workflow → **LLM provider** = `gemini` |
| One PR revision | include `llm=gemini` in the `@claude` comment |

Optional variable `HOTFIX_GEMINI_MODEL` pins the Gemini model (default: the
Gemini CLI's own default), e.g. `gemini-3-pro-preview`.
