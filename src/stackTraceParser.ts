/**
 * stackTraceParser.ts
 *
 * Parses a JVM / Android (Java & Kotlin) stack trace string into a structured
 * object that downstream steps of the HotFix pipeline can reason about:
 *   - the thrown exception (and any "Caused by:" chain)
 *   - every frame, split into class / method / file / line
 *   - which frames belong to YOUR app vs. the framework/SDK
 *   - a best guess at the "culprit" frame (the file a fix should target)
 *   - a CONFIDENCE hint: is this crash type likely a clean single-file fix?
 *
 * NOTE: `isLikelyAutoFixable` is now used as a CONFIDENCE label, not a gate.
 * The pipeline attempts a fix for every crash; this flag only decides whether
 * Slack shows it as "auto-fixing" (high confidence) or "needs human attention"
 * (low confidence). See index.ts.
 *
 * It is pure logic with no Firebase / network dependencies, so it is trivial
 * to unit-test and to port to another runtime (e.g. a JVM agent step) later.
 */

export interface StackFrame {
  /** The original line, untouched. Useful for the PR description. */
  rawLine: string;
  /** Fully-qualified class, e.g. "com.example.app.HomeViewModel$loadData$1". */
  className: string;
  /** Method (or lambda) name, e.g. "loadExpenses" or "invoke". */
  methodName: string;
  /** Source file, e.g. "HomeViewModel.kt". null for Native/Unknown frames. */
  fileName: string | null;
  /** Line number, or null when the frame has no source location. */
  lineNumber: number | null;
  /** True when className starts with one of the configured app prefixes. */
  isAppCode: boolean;
}

export interface ExceptionInfo {
  /** Fully-qualified type, e.g. "kotlin.KotlinNullPointerException". */
  type: string;
  /** Last segment of the type, e.g. "KotlinNullPointerException". */
  simpleType: string;
  /** The exception message, or null if none was present. */
  message: string | null;
  /** Frames belonging to this exception, top (most recent call) first. */
  frames: StackFrame[];
}

export interface ParsedStackTrace {
  /** Every exception in the order encountered: [thrown, cause1, cause2, ...]. */
  exceptions: ExceptionInfo[];
  /** The exception that was actually thrown (the first one). */
  rootException: ExceptionInfo;
  /** The deepest "Caused by:" — usually where the real bug lives. */
  deepestCause: ExceptionInfo;
  /** Every app-code frame across all exceptions, top-down. */
  appFrames: StackFrame[];
  /** Best single guess at the file/line a fix should target, or null. */
  culpritFrame: StackFrame | null;
  /** Confidence hint: is this crash type likely a clean single-file fix? */
  isLikelyAutoFixable: boolean;
  /** Human-readable reason for the confidence decision (good for logs / PRs). */
  triageReason: string;
}

export interface ParserOptions {
  /**
   * Package prefixes that identify YOUR code, e.g. ["com.example.expensesbook"].
   * Frames outside these are treated as framework/library noise.
   */
  appPackages: string[];
}

/**
 * Exception types a focused single-file patch can plausibly fix.
 * This list now drives the CONFIDENCE label (auto vs needs_human), not whether
 * the agent runs — the agent attempts every crash. Add types here as you
 * confirm them fixable on real crashes (e.g. ActivityNotFoundException).
 */
const AUTO_FIXABLE_TYPES = new Set([
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
  "android.content.ActivityNotFoundException", // confirmed fixable on real crashes
]);

/** Types we treat as LOW confidence: symptoms / systemic, not single-file bugs. */
const NOT_AUTO_FIXABLE_TYPES = new Set([
  "java.lang.OutOfMemoryError",
  "java.lang.StackOverflowError",
  "android.os.DeadSystemException",
  "java.util.ConcurrentModificationException", // usually a race condition
  "android.app.RemoteServiceException",
]);

// "  at com.example.Foo$Bar.method(File.kt:42)"  ->  groups for fqMethod + location
const FRAME_RE =
  /^\s*at\s+([\w$.<>+\- ]+?)\((Unknown Source|Native Method|SourceFile|[^():]+?(?::\d+)?)\)\s*$/;
// "Caused by: java.lang.IllegalStateException: message"  /  thrown header line
const HEADER_RE =
  /^(?:(Caused by|Suppressed):\s+)?([\w$.]+(?:Exception|Error|Throwable))(?::\s?(.*))?$/;

function classifyFrame(className: string, appPackages: string[]): boolean {
  return appPackages.some((p) => className.startsWith(p));
}

function parseLocation(loc: string): { file: string | null; line: number | null } {
  if (loc === "Unknown Source" || loc === "Native Method" || loc === "SourceFile") {
    return { file: null, line: null };
  }
  const m = loc.match(/^(.+?)(?::(\d+))?$/);
  if (!m) return { file: null, line: null };
  return { file: m[1], line: m[2] ? parseInt(m[2], 10) : null };
}

function parseFrame(line: string, appPackages: string[]): StackFrame | null {
  const m = line.match(FRAME_RE);
  if (!m) return null;
  const fqMethod = m[1].trim();
  const lastDot = fqMethod.lastIndexOf(".");
  const className = lastDot >= 0 ? fqMethod.slice(0, lastDot) : fqMethod;
  const methodName = lastDot >= 0 ? fqMethod.slice(lastDot + 1) : fqMethod;
  const { file, line: lineNumber } = parseLocation(m[2]);
  return {
    rawLine: line.trim(),
    className,
    methodName,
    fileName: file,
    lineNumber,
    isAppCode: classifyFrame(className, appPackages),
  };
}

/**
 * Parse a full stack trace string into structured form.
 *
 * @param raw  The stack trace text (may include "Fatal Exception:" prefixes,
 *             "Caused by:" chains, and "..." truncation markers).
 * @param opts appPackages is required so we can tell your code from the SDK.
 */
export function parseStackTrace(raw: string, opts: ParserOptions): ParsedStackTrace {
  const appPackages = opts.appPackages ?? [];
  // Crashlytics often prefixes the first line; strip common labels.
  const lines = raw
    .replace(/^\s*(Fatal|Non-fatal) Exception:\s*/i, "")
    .split(/\r?\n/);

  const exceptions: ExceptionInfo[] = [];
  let current: ExceptionInfo | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    const frame = parseFrame(line, appPackages);
    if (frame && current) {
      current.frames.push(frame);
      continue;
    }
    if (line.trim().startsWith("...")) continue; // "... 12 more" truncation

    const header = line.match(HEADER_RE);
    if (header) {
      const type = header[2];
      current = {
        type,
        simpleType: type.slice(type.lastIndexOf(".") + 1),
        message: header[3]?.trim() || null,
        frames: [],
      };
      exceptions.push(current);
    }
    // Any other line (device metadata, thread names, etc.) is ignored.
  }

  if (exceptions.length === 0) {
    const empty: ExceptionInfo = {
      type: "unknown",
      simpleType: "unknown",
      message: null,
      frames: [],
    };
    return {
      exceptions: [empty],
      rootException: empty,
      deepestCause: empty,
      appFrames: [],
      culpritFrame: null,
      isLikelyAutoFixable: false,
      triageReason: "Could not parse any exception from the trace.",
    };
  }

  const rootException = exceptions[0];
  const deepestCause = exceptions[exceptions.length - 1];

  // App frames across the whole chain, deepest-cause first (more likely the bug),
  // then the thrown exception. Within each, top frame first.
  const appFrames: StackFrame[] = [
    ...deepestCause.frames.filter((f) => f.isAppCode),
    ...rootException.frames.filter((f) => f.isAppCode && deepestCause !== rootException),
  ];

  const culpritFrame =
    appFrames.find((f) => f.fileName && f.lineNumber !== null) ?? appFrames[0] ?? null;

  const { fixable, reason } = triage(rootException, deepestCause, culpritFrame);

  return {
    exceptions,
    rootException,
    deepestCause,
    appFrames,
    culpritFrame,
    isLikelyAutoFixable: fixable,
    triageReason: reason,
  };
}

/**
 * Decide the CONFIDENCE label for a crash (not a gate — the agent attempts
 * every crash). High confidence = an auto-fixable type with an app-owned
 * culprit frame. Everything else is flagged for human attention.
 */
function triage(
  root: ExceptionInfo,
  cause: ExceptionInfo,
  culprit: StackFrame | null,
): { fixable: boolean; reason: string } {
  // Judge on the deepest cause's type — that's the real failure.
  const type = cause.type;
  if (NOT_AUTO_FIXABLE_TYPES.has(type)) {
    return { fixable: false, reason: `${type} is typically systemic, not a single-file bug.` };
  }
  if (!culprit) {
    return { fixable: false, reason: "No app-owned frame found; crash is inside the SDK/framework." };
  }
  if (!AUTO_FIXABLE_TYPES.has(type)) {
    return {
      fixable: false,
      reason: `${type} is not on the high-confidence allow-list; flag for human attention.`,
    };
  }
  // Auto-fixable type with an app-owned culprit. Exact file:line is a bonus —
  // if we only have the class+method, the agent resolves the line in the repo.
  if (culprit.fileName && culprit.lineNumber !== null) {
    return {
      fixable: true,
      reason: `${cause.simpleType} at ${culprit.fileName}:${culprit.lineNumber} is a tractable, localized crash.`,
    };
  }
  return {
    fixable: true,
    reason: `${cause.simpleType} in ${culprit.className}.${culprit.methodName} is tractable; agent will locate the exact line in the repo.`,
  };
}
