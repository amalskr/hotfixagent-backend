/**
 * index.ts — HotFixAgent
 *
 * Triggers:
 *   - hotfixOnFatalCrash      → fires on a NEW fatal issue (first time seen)
 *   - hotfixOnRegression      → fires when a CLOSED issue crashes again
 *   - hotfixStatusCallback    → HTTP endpoint the workflow calls AFTER the agent
 *                               runs, to post a second Slack message with the
 *                               PR outcome (opened / draft / could-not-fix).
 *
 * Design note: triage no longer GATES the agent. Every crash is attempted once.
 * Triage instead produces a CONFIDENCE label ("auto" vs "needs_human") that is
 * shown in Slack so reviewers know which PRs to scrutinise. A human still
 * reviews and merges every PR.
 */

import {
  onNewFatalIssuePublished,
  onRegressionAlertPublished,
} from "firebase-functions/v2/alerts/crashlytics";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import { parseStackTrace, type ParsedStackTrace } from "./stackTraceParser";

const APP_PACKAGES = ["com.ceylonapz.hotfixagent"];
const GITHUB_REPO = "amalskr/HotfixAgent";
const PROJECT_ID = "hotfixagent";
const ANDROID_APP = "android:com.ceylonapz.hotfixagent";

const githubToken = defineSecret("GITHUB_TOKEN");
const slackWebhook = defineSecret("SLACK_WEBHOOK_URL");
const callbackToken = defineSecret("CALLBACK_TOKEN");

const opts = {
  region: "asia-southeast1",
  memory: "512MiB" as const,
  retry: false,
  secrets: [githubToken, slackWebhook],
};

type Confidence = "auto" | "needs_human";

// New, first-seen fatal crash.
export const hotfixOnFatalCrash = onNewFatalIssuePublished(opts, async (event) => {
  const i = event.data.payload.issue;
  await handleCrash(i.id, i.title, i.subtitle, i.appVersion, "new");
});

// A previously CLOSED issue started crashing again.
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
    appPackages: APP_PACKAGES,
  });
  logTriage(id, parsed);

  const culprit = parsed.culpritFrame;
  // Triage is now a CONFIDENCE signal, not a gate.
  const confidence: Confidence = parsed.isLikelyAutoFixable ? "auto" : "needs_human";

  const common = {
    issueId: id,
    origin,
    exceptionType: parsed.deepestCause.type,
    message: parsed.deepestCause.message ?? "",
    targetClass: culprit?.className ?? "unknown",
    targetMethod: culprit?.methodName ?? "unknown",
  };

  // 1) Tell Slack we're attempting (with the confidence label + reason).
  await notifySlack(slackWebhook.value(), {
    ...common,
    confidence,
    reason: parsed.triageReason,
  });

  // 2) ALWAYS dispatch — the agent attempts every crash, once.
  logger.info("Dispatching fix attempt", { issueId: id, confidence });
  await triggerGitHubWorkflow({ ...common, appVersion, confidence }, githubToken.value());
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
}

/** Initial "attempting a fix" notification. */
async function notifySlack(webhookUrl: string, o: SlackOpts): Promise<void> {
  const tag = o.origin === "regression" ? " (regression)" : "";
  const auto = o.confidence === "auto";
  const headline = auto
    ? `🤖 HotFixAgent — auto-fixing a crash${tag}`
    : `🟠 HotFixAgent — attempting a fix; human attention recommended${tag}`;
  const outcome = auto
    ? "Attempting a fix and opening a pull request against `main`…"
    : `Attempting a fix (low confidence). Flagged for human attention: ${o.reason ?? "uncertain root cause"}`;

  const text = [
    `*${headline}*`,
    `*${o.exceptionType}*${o.message ? ` — ${o.message}` : ""}`,
    `at \`${o.targetClass}.${o.targetMethod}\``,
    outcome,
    `<${issueUrl(o.issueId)}|View in Crashlytics>`,
  ].join("\n");

  await postSlack(webhookUrl, text);
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
    body = o.prUrl ? `<${o.prUrl}|Review and merge the PR>` : "A pull request was opened.";
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
  { region: "asia-southeast1", secrets: [slackWebhook, callbackToken] },
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

    await postSlack(slackWebhook.value(), buildStatusText(b as StatusOpts));
    logger.info("Status callback posted to Slack", { issueId: b.issueId, status: b.status });
    res.status(200).send("ok");
  },
);

/* ──────────────────── shared Slack sender ──────────────────── */

function issueUrl(issueId: string): string {
  return (
    `https://console.firebase.google.com/project/${PROJECT_ID}` +
    `/crashlytics/app/${ANDROID_APP}/issues/${issueId}`
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

/* ──────────────────── GitHub dispatch ──────────────────── */

/** Fire a repository_dispatch so the hotfix-agent workflow runs. */
async function triggerGitHubWorkflow(
  payload: Record<string, unknown>,
  token: string,
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "HotFixAgent",
    },
    body: JSON.stringify({ event_type: "hotfix-crash", client_payload: payload }),
  });
  if (!res.ok) {
    logger.error("repository_dispatch failed", {
      status: res.status,
      body: await res.text(),
    });
    return;
  }
  logger.info("repository_dispatch sent to GitHub", { issueId: payload.issueId });
}

/* ──────────────────── helpers ──────────────────── */

function buildTraceFromAlert(title: string, subtitle: string): string {
  const type = extractType(subtitle);
  const symbol = title?.trim() || `${APP_PACKAGES[0]}.Unknown.unknown`;
  return `${type}\n\tat ${symbol}(Unknown Source)`;
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
