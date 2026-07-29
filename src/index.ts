/**
 * index.ts — HotFixAgent Cloud Functions.
 *
 * App-specific settings live in ONE place: ./hotfix.config.ts.
 * This file contains no hard-coded app/repo/project values.
 *
 * Triggers:
 *   - hotfixOnFatalCrash    → new fatal Crashlytics issue (first time seen)
 *   - hotfixOnRegression    → a resolved issue crashes again
 *   - hotfixStatusCallback  → HTTP endpoint the workflow calls after the agent
 *                             runs, to post a 2nd Slack message with the PR
 *                             outcome (opened / draft / could-not-fix).
 *
 * Design: triage does NOT gate the agent. Every crash is attempted once. Triage
 * produces a CONFIDENCE label ("auto" vs "needs_human") shown in Slack so
 * reviewers know which PRs to scrutinise. A human reviews and merges every PR.
 */

import {
  onNewFatalIssuePublished,
  onRegressionAlertPublished,
} from "firebase-functions/v2/alerts/crashlytics";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import { parseStackTrace, type ParsedStackTrace } from "./stackTraceParser";
import { evaluate as guardEvaluate } from "./githubGuard";
import { config } from "./hotfix.config";

const githubToken = defineSecret("GITHUB_TOKEN");
const slackWebhook = defineSecret("SLACK_WEBHOOK_URL");
const callbackToken = defineSecret("CALLBACK_TOKEN");

const opts = {
  region: config.region,
  memory: config.functionMemory,
  retry: false,
  secrets: [githubToken, slackWebhook],
};

type Confidence = "auto" | "needs_human";

// New, first-seen fatal crash.
export const hotfixOnFatalCrash = onNewFatalIssuePublished(opts, async (event) => {
  const i = event.data.payload.issue;
  await handleCrash(i.id, i.title, i.subtitle, i.appVersion, "new");
});

// A previously resolved issue started crashing again.
export const hotfixOnRegression = onRegressionAlertPublished(opts, async (event) => {
  const i = event.data.payload.issue;
  await handleCrash(i.id, i.title, i.subtitle, i.appVersion, "regression");
});

/** Shared pipeline: parse → label confidence → Slack → ALWAYS dispatch. */
async function handleCrash(
  id: string,
  title: string,
  subtitle: string,
  appVersion: string,
  origin: "new" | "regression",
): Promise<void> {
  logger.info("Crash alert received", { issueId: id, title, subtitle, origin });

  const parsed = parseStackTrace(buildTraceFromAlert(title, subtitle), {
    appPackages: config.appPackages,
    autoFixableTypes: config.autoFixableTypes,
    notAutoFixableTypes: config.notAutoFixableTypes,
    treatObfuscatedFramesAsApp: config.treatObfuscatedFramesAsApp,
  });
  logTriage(id, parsed);

  const culprit = parsed.culpritFrame;
  const confidence: Confidence = parsed.isLikelyAutoFixable ? "auto" : "needs_human";

  const common = {
    issueId: id,
    origin,
    exceptionType: parsed.deepestCause.type,
    message: parsed.deepestCause.message ?? "",
    targetClass: culprit?.className ?? "unknown",
    targetMethod: culprit?.methodName ?? "unknown",
  };

  // Deterministic branch name: agent/<exception>-<method>-<issueId>.
  // Computed here (one source) so the loop guard, workflow, agent and status
  // step all reference the exact same branch.
  const branchName = buildBranchName(id, common.exceptionType, common.targetMethod);

  // Loop guard (GitHub-native): suppress duplicates, cap repeated attempts.
  const guard = await guardEvaluate(branchName, githubToken.value(), config.maxAttemptsPerIssue);
  logger.info("Loop-guard decision", { issueId: id, ...guard });

  // Duplicate of an active issue → no Slack, no agent run.
  if (!guard.shouldNotify && !guard.shouldDispatch) {
    logger.info("Suppressed duplicate", { issueId: id, reason: guard.reason });
    return;
  }

  // Cap reached → notify once that it keeps recurring; do NOT dispatch.
  if (guard.capReached) {
    await postSlack(
      slackWebhook.value(),
      withMentions(
        [
          `*❗ HotFixAgent — crash keeps recurring after ${guard.attempts} attempts · needs a human*`,
          `*${common.exceptionType}*${common.message ? ` — ${common.message}` : ""}`,
          `at \`${common.targetClass}.${common.targetMethod}\``,
          `<${issueUrl(id)}|Investigate in Crashlytics>`,
        ].join("\n"),
      ),
    );
    return;
  }

  // Dispatch policy (cost/noise control): may downgrade dispatch to notify-only.
  let willDispatch = guard.shouldDispatch;
  if (config.dispatchMode === "notify-only") {
    willDispatch = false;
  } else if (config.dispatchMode === "auto-only" && confidence === "needs_human") {
    willDispatch = false;
  }

  // 1) One Slack message (de-duplicated by the guard), mentions devs.
  if (guard.shouldNotify) {
    await notifySlack(slackWebhook.value(), {
      ...common,
      confidence,
      reason: parsed.triageReason,
      willAttempt: willDispatch,
    });
  }

  // 2) Dispatch the agent — once per active issue, if policy allows.
  if (willDispatch) {
    logger.info("Dispatching fix attempt", {
      issueId: id,
      confidence,
      attempt: guard.attempts,
      llm: config.llmProvider,
    });
    await triggerGitHubWorkflow(
      { ...common, appVersion, confidence, branchName, llm: config.llmProvider },
      githubToken.value(),
    );
  } else {
    logger.info("Not dispatching (policy)", { issueId: id, mode: config.dispatchMode, confidence });
  }
}

/** Prefix Slack member mentions (from config) to a message, if any. */
function withMentions(text: string): string {
  const ids = config.slackMentionUserIds ?? [];
  if (ids.length === 0) return text;
  const mentions = ids.map((u: string) => `<@${u}>`).join(" ");
  return `${mentions}\n${text}`;
}

/** kebab-case, alphanumerics only, trimmed to a sane length. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
}

/**
 * Deterministic hotfix branch name: agent/<exception>-<method>-<issueId>.
 * Deterministic (not agent-invented) so the loop guard can find the PR by head.
 * e.g. NullPointerException in getName → "agent/nullpointer-getname-a3f8b2c1".
 */
function buildBranchName(issueId: string, exceptionType: string, method: string): string {
  const simple = exceptionType.slice(exceptionType.lastIndexOf(".") + 1);
  const exc = simple.replace(/(exception|error)$/i, ""); // drop noisy suffix
  const slug = slugify(`${exc}-${method}`) || "crash";
  return `agent/${slug}-${issueId}`;
}

/* ───────────────────────── Slack ───────────────────────── */

interface SlackOpts {
  issueId: string;
  origin: "new" | "regression";
  exceptionType: string;
  message: string;
  targetClass: string;
  targetMethod: string;
  confidence: Confidence;
  reason?: string;
  /** Whether the agent will actually run (false in observe / auto-only modes). */
  willAttempt: boolean;
}

/** Crash notification (attempting, or observe-only depending on policy). */
async function notifySlack(webhookUrl: string, o: SlackOpts): Promise<void> {
  const tag = o.origin === "regression" ? " (regression)" : "";
  const auto = o.confidence === "auto";

  let headline: string;
  let outcome: string;
  if (!o.willAttempt) {
    // Observe / auto-only: we are NOT running the agent, just flagging for a human.
    headline = `👀 HotFixAgent — crash logged · needs human attention${tag}`;
    outcome = `Not auto-attempting (policy / low confidence): ${o.reason ?? "flagged for review"}`;
  } else if (auto) {
    headline = `🤖 HotFixAgent — auto-fixing a crash${tag}`;
    outcome = `Attempting a fix and opening a pull request against \`${config.targetBranch}\`…`;
  } else {
    headline = `🟠 HotFixAgent — attempting a fix; human attention recommended${tag}`;
    outcome = `Attempting a fix (low confidence). Flagged for human attention: ${o.reason ?? "uncertain root cause"}`;
  }

  const text = [
    `*${headline}*`,
    `*${o.exceptionType}*${o.message ? ` — ${o.message}` : ""}`,
    `at \`${o.targetClass}.${o.targetMethod}\``,
    outcome,
    `<${issueUrl(o.issueId)}|View in Crashlytics>`,
  ].join("\n");

  await postSlack(webhookUrl, withMentions(text));
}

/* ──────────────── PR-status callback (second message) ──────────────── */

type Status = "pr_opened" | "draft" | "failed";

interface StatusOpts {
  issueId: string;
  status: Status;
  prUrl?: string;
  exceptionType?: string;
  targetClass?: string;
  targetMethod?: string;
  summary?: string;
}

function buildStatusText(o: StatusOpts): string {
  const typeLine = `*${o.exceptionType ?? "crash"}*`;
  const at = `at \`${o.targetClass ?? "unknown"}.${o.targetMethod ?? "unknown"}\``;

  let headline: string;
  let body: string;
  switch (o.status) {
  case "pr_opened":
    headline = "✅ HotFixAgent — pull request ready for review";
    // summary names the LLM that produced the fix (Claude, or the Gemini fallback).
    body =
        (o.prUrl ? `<${o.prUrl}|Review and merge the PR>` : "A pull request was opened.") +
        (o.summary ? `\n_${o.summary}_` : "");
    break;
  case "draft":
    headline = "📝 HotFixAgent — DRAFT PR opened · needs human attention";
    body =
        (o.prUrl ? `<${o.prUrl}|Review the draft>` : "A draft PR was opened.") +
        (o.summary ? `\n_${o.summary}_` : "");
    break;
  case "failed":
  default:
    headline = "❗ HotFixAgent — could not fix automatically · needs human attention";
    body =
        (o.summary ? `_${o.summary}_\n` : "") +
        `<${issueUrl(o.issueId)}|Investigate in Crashlytics>`;
    break;
  }
  return [`*${headline}*`, typeLine, at, body].join("\n");
}

/**
 * HTTP endpoint called by the GitHub workflow after the agent finishes.
 * Secured with a shared bearer token (CALLBACK_TOKEN). POST JSON:
 *   { issueId, status: "pr_opened"|"draft"|"failed",
 *     prUrl?, exceptionType?, targetClass?, targetMethod?, summary? }
 */
export const hotfixStatusCallback = onRequest(
  { region: config.region, secrets: [slackWebhook, callbackToken] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("method not allowed");
      return;
    }
    const expected = callbackToken.value();
    if (!expected || req.get("Authorization") !== `Bearer ${expected}`) {
      res.status(401).send("unauthorized");
      return;
    }

    const b = (req.body ?? {}) as Partial<StatusOpts>;
    if (!b.issueId || !b.status) {
      res.status(400).send("missing issueId or status");
      return;
    }

    await postSlack(slackWebhook.value(), withMentions(buildStatusText(b as StatusOpts)));
    logger.info("Status callback posted to Slack", { issueId: b.issueId, status: b.status });
    res.status(200).send("ok");
  },
);

/* ──────────────────── shared helpers ──────────────────── */

function issueUrl(issueId: string): string {
  return (
    `https://console.firebase.google.com/project/${config.firebaseProjectId}` +
    `/crashlytics/app/${config.crashlyticsAppId}/issues/${issueId}`
  );
}

/** POST text to Slack. Retries transient failures (429/5xx); never throws. */
async function postSlack(webhookUrl: string, text: string): Promise<void> {
  if (!webhookUrl) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) return;
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get("Retry-After") ?? attempt);
        logger.warn("Slack rate-limited; retrying", { status: res.status, attempt });
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      logger.error("Slack post failed (no retry)", { status: res.status });
      return;
    } catch {
      logger.error("Slack post threw; retrying", { attempt });
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  logger.error("Slack post failed after 3 attempts");
}

/** Fire a repository_dispatch so the hotfix-agent workflow runs. */
async function triggerGitHubWorkflow(
  payload: Record<string, unknown>,
  token: string,
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${config.githubRepo}/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "HotFixAgent",
    },
    body: JSON.stringify({ event_type: config.dispatchEventType, client_payload: payload }),
  });
  if (!res.ok) {
    logger.error("repository_dispatch failed", { status: res.status, body: await res.text() });
    return;
  }
  logger.info("repository_dispatch sent to GitHub", { issueId: payload.issueId });
}

function buildTraceFromAlert(title: string, subtitle: string): string {
  const type = extractType(subtitle);
  const { symbol, file } = parseAlertTitle(title);
  return `${type}\n\tat ${symbol}(${file})`;
}

/**
 * Crashlytics issue titles come in a few shapes; pull out the code symbol
 * (class.method) and, if present, the source file:
 *   "wq.h0"                          → symbol "wq.h0",            file "Unknown Source"
 *   "SourceFile - wb.g"              → symbol "wb.g",             file "SourceFile"
 *   "PriceParser.kt - com.x.Foo.bar" → symbol "com.x.Foo.bar",   file "PriceParser.kt"
 * The symbol part is whatever looks most like a dotted code path.
 */
function parseAlertTitle(title: string): { symbol: string; file: string } {
  const fallback = `${config.appPackages[0]}.Unknown.unknown`;
  const t = (title ?? "").trim();
  if (!t) return { symbol: fallback, file: "Unknown Source" };

  // "<file> - <symbol>"  (Crashlytics often prefixes the source file)
  const dash = t.split(/\s+-\s+/);
  if (dash.length === 2) {
    const [left, right] = dash.map((p) => p.trim());
    // The code symbol is the side that contains a dot-path / method ref.
    const symbol = /[.$]/.test(right) ? right : left;
    const file = symbol === right ? left : right;
    return { symbol: symbol || fallback, file: file || "Unknown Source" };
  }
  return { symbol: t, file: "Unknown Source" };
}

function extractType(subtitle: string): string {
  return (
    subtitle?.match(/([\w$.]+(?:Exception|Error|Throwable))/)?.[1] ??
    "java.lang.RuntimeException"
  );
}

function logTriage(issueId: string, parsed: ParsedStackTrace): void {
  logger.info("Triage result", {
    issueId,
    thrown: parsed.rootException.type,
    deepestCause: parsed.deepestCause.type,
    culprit: parsed.culpritFrame
      ? `${parsed.culpritFrame.className}.${parsed.culpritFrame.methodName}`
      : null,
    confidence: parsed.isLikelyAutoFixable ? "auto" : "needs_human",
    reason: parsed.triageReason,
  });
}
