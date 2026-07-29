/**
 * hotfix.config.ts — SINGLE SOURCE OF TRUTH (backend side).
 *
 * To run HotFixAgent on a DIFFERENT app, change ONLY this file for the backend.
 * Nothing else in src/ contains app-specific values. (The CI side has its own
 * single place: GitHub repo "Variables" — see README "Deploy to a new app".)
 *
 * Everything here is non-secret. Secrets (API keys, tokens, webhook) are set
 * separately via `firebase functions:secrets:set` — never put them in this file.
 */

export interface HotFixConfig {
  /** Package prefixes that identify YOUR app code (vs framework/SDK). */
  appPackages: string[];
  /** GitHub repo the fix PRs are opened in, "owner/repo". */
  githubRepo: string;
  /** Firebase project id (used to build the Crashlytics console URL). */
  firebaseProjectId: string;
  /** Crashlytics app id, e.g. "android:com.example.app". */
  crashlyticsAppId: string;
  /** Cloud Functions region. */
  region: string;
  /** Branch the live app is shipped from; hotfix PRs target this. */
  targetBranch: string;
  /** repository_dispatch event type the GitHub workflow listens for. */
  dispatchEventType: string;
  /** Cloud Function memory. */
  functionMemory: "256MiB" | "512MiB" | "1GiB";
  /** Slack member IDs to @mention on each crash notification (de-duplicated). */
  slackMentionUserIds: string[];
  /** Max agent attempts per crash issue before flagging for a human only. */
  maxAttemptsPerIssue: number;
  /** Dispatch policy (cost/noise control for high-traffic apps). */
  dispatchMode: "all" | "auto-only" | "notify-only";
  /**
   * Which LLM the repair agent runs on, sent to CI in the dispatch payload.
   *  "auto"   – Claude, falling back to Gemini when the Anthropic API is out of
   *             quota / rate limited (the workflow pre-checks before each run)
   *  "claude" – always Claude
   *  "gemini" – always Gemini
   */
  llmProvider: "auto" | "claude" | "gemini";
  /** HIGH-confidence crash types: localised, likely a single-file fix. Tune per app. */
  autoFixableTypes: string[];
  /** LOW-confidence crash types: systemic/environmental. Tune per app. */
  notAutoFixableTypes: string[];
  /** Treat obfuscated, non-framework frames as app candidates (default true). */
  treatObfuscatedFramesAsApp: boolean;
}

export const config: HotFixConfig = {
  // ─────────── CHANGE THESE FOR A NEW APP ───────────
  appPackages: ["com.ceylonapz.hotfixagent"],
  githubRepo: "amalskr/HotfixAgent",
  firebaseProjectId: "hotfixagent",
  crashlyticsAppId: "android:com.ceylonapz.hotfixagent",
  region: "asia-southeast1",
  targetBranch: "main",
  // ──────────────────────────────────────────────────

  dispatchEventType: "hotfix-crash",
  functionMemory: "512MiB",

  // ─── Slack: who to @mention on each (de-duplicated) crash notification ───
  // Slack MEMBER IDs (not @handles), e.g. "U01ABCD2EF". Empty = no mention.
  // Find one in Slack: profile → ⋮ → "Copy member ID".
  slackMentionUserIds: ["U039VCAQBEW"],

  // ─── Loop guard (GitHub-native; no database) ───
  // Max hotfix PRs per crash issue before we stop dispatching and only flag it
  // for a human. De-duplication uses existing GitHub PRs + Actions concurrency.
  maxAttemptsPerIssue: 3,

  // ─── Dispatch policy ───
  //  "all"         – attempt EVERY crash (paper design; max coverage, max cost)
  //  "auto-only"   – attempt only HIGH-confidence; needs_human = notify only
  //  "notify-only" – never run the agent; Slack only (shadow / observe mode)
  // High-traffic app? Start "notify-only" (observe volume), then "auto-only".
  dispatchMode: "all",

  // ─── LLM provider ───
  // "auto" = Claude first, automatic switch to Gemini when the Anthropic API is
  // over quota / rate limited. Pin to "gemini" (or "claude") to stop switching.
  // The CI secrets ANTHROPIC_API_KEY / GEMINI_API_KEY decide what is available;
  // "auto" with only one key set simply uses that one.
  llmProvider: "auto",

  // Production apps are minified; if R8/ProGuard mapping deobfuscation is missing,
  // still treat obfuscated non-framework frames (e.g. "wq.h0") as app candidates.
  treatObfuscatedFramesAsApp: true,

  // Confidence taxonomy. Add a type to autoFixableTypes once you confirm it is
  // reliably fixable on real crashes for THIS app.
  autoFixableTypes: [
    "java.lang.NullPointerException",
    "kotlin.KotlinNullPointerException",
    "java.lang.IndexOutOfBoundsException",
    "java.lang.ArrayIndexOutOfBoundsException",
    "java.lang.StringIndexOutOfBoundsException",
    "java.lang.IllegalStateException",
    "java.lang.IllegalArgumentException",
    "java.lang.ClassCastException",
    "java.lang.NumberFormatException",
    "java.lang.ArithmeticException",
    "kotlin.UninitializedPropertyAccessException",
    "java.util.NoSuchElementException",
    "android.database.CursorIndexOutOfBoundsException",
    "android.content.ActivityNotFoundException",
  ],
  notAutoFixableTypes: [
    "java.lang.OutOfMemoryError",
    "java.lang.StackOverflowError",
    "android.os.DeadSystemException",
    "java.util.ConcurrentModificationException",
    "android.app.RemoteServiceException",
  ],
};
