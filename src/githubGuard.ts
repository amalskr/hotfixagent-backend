/**
 * githubGuard.ts — loop guard that uses GitHub itself as the state store.
 *
 * No database, no extra service, no extra cost. Before dispatching we ask GitHub
 * whether a hotfix PR already exists for this crash issue:
 *
 *   • An OPEN PR for head `agent/<slug>-<issueId>` → already handled → suppress
 *     (no duplicate Slack, no second agent run).
 *   • No PR yet                                → first occurrence → notify + dispatch.
 *   • Only CLOSED/MERGED PRs, count ≥ cap      → keeps coming back → flag a human,
 *     don't dispatch again (attempt cap).
 *   • Otherwise (closed PRs < cap)             → genuine regression → re-attempt.
 *
 * A GitHub Actions `concurrency` group in the workflow gives the atomic guarantee
 * against two events racing at the same instant.
 */

import { config } from "./hotfix.config";

export interface GuardDecision {
  shouldNotify: boolean;
  shouldDispatch: boolean;
  capReached: boolean;
  attempts: number;
  reason: string;
}

interface GitHubPR {
  state: string; // "open" | "closed"
  draft: boolean;
  html_url: string;
  merged_at: string | null;
}

async function gh(path: string, token: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "HotFixAgent",
    },
  });
}

/** Decide whether to notify/dispatch for this crash, based on existing PRs. */
export async function evaluate(
  branchName: string,
  token: string,
  maxAttempts: number,
): Promise<GuardDecision> {
  const owner = config.githubRepo.split("/")[0];
  const head = `${owner}:${branchName}`;
  const res = await gh(
    `/repos/${config.githubRepo}/pulls?head=${encodeURIComponent(head)}&state=all&per_page=100`,
    token,
  );

  // Fail OPEN: if the check itself fails, proceed rather than silently drop a crash.
  if (!res.ok) {
    return mk(true, true, false, 0, `PR check failed (HTTP ${res.status}); proceeding`);
  }

  const prs = (await res.json()) as GitHubPR[];
  const open = prs.filter((p) => p.state === "open");

  // Already being handled → no duplicate Slack, no second run.
  if (open.length > 0) {
    return mk(false, false, false, prs.length, "open PR already exists; duplicate suppressed");
  }

  const attempts = prs.length; // closed/merged PRs = previous attempts
  if (attempts >= maxAttempts) {
    return mk(true, false, true, attempts, `attempt cap (${maxAttempts}) reached after ${attempts} PR(s)`);
  }

  return mk(
    true,
    true,
    false,
    attempts,
    attempts === 0 ? "first occurrence" : `regression re-attempt #${attempts + 1}`,
  );
}

function mk(
  shouldNotify: boolean,
  shouldDispatch: boolean,
  capReached: boolean,
  attempts: number,
  reason: string,
): GuardDecision {
  return { shouldNotify, shouldDispatch, capReached, attempts, reason };
}
