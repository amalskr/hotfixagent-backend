/**
 * stackTraceParser.ts
 *
 * Pure logic (no Firebase/network) that turns a JVM/Android stack-trace string
 * into a structured object: the thrown exception + "Caused by" chain, every
 * frame split into class/method/file/line, which frames are YOUR app vs SDK,
 * a best-guess "culprit" frame, and a CONFIDENCE hint.
 *
 * The confidence type lists default to a sensible Android set but can be
 * overridden per app via ParserOptions (the backend passes them from
 * hotfix.config.ts), so this file needs no app-specific edits.
 */

export interface StackFrame {
  rawLine: string;
  className: string;
  methodName: string;
  fileName: string | null;
  lineNumber: number | null;
  isAppCode: boolean;
}

export interface ExceptionInfo {
  type: string;
  simpleType: string;
  message: string | null;
  frames: StackFrame[];
}

export interface ParsedStackTrace {
  exceptions: ExceptionInfo[];
  rootException: ExceptionInfo;
  deepestCause: ExceptionInfo;
  appFrames: StackFrame[];
  culpritFrame: StackFrame | null;
  isLikelyAutoFixable: boolean;
  triageReason: string;
}

export interface ParserOptions {
  /** Package prefixes that identify YOUR code, e.g. ["com.example.app"]. */
  appPackages: string[];
  /** HIGH-confidence types (override the defaults). */
  autoFixableTypes?: string[];
  /** LOW-confidence types (override the defaults). */
  notAutoFixableTypes?: string[];
}

/** Defaults used when ParserOptions does not supply the lists. */
const DEFAULT_AUTO_FIXABLE = [
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
];
const DEFAULT_NOT_AUTO_FIXABLE = [
  "java.lang.OutOfMemoryError",
  "java.lang.StackOverflowError",
  "android.os.DeadSystemException",
  "java.util.ConcurrentModificationException",
  "android.app.RemoteServiceException",
];

const FRAME_RE =
  /^\s*at\s+([\w$.<>+\- ]+?)\((Unknown Source|Native Method|SourceFile|[^():]+?(?::\d+)?)\)\s*$/;
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

export function parseStackTrace(raw: string, opts: ParserOptions): ParsedStackTrace {
  const appPackages = opts.appPackages ?? [];
  const autoFixable = new Set(opts.autoFixableTypes ?? DEFAULT_AUTO_FIXABLE);
  const notAutoFixable = new Set(opts.notAutoFixableTypes ?? DEFAULT_NOT_AUTO_FIXABLE);

  const lines = raw.replace(/^\s*(Fatal|Non-fatal) Exception:\s*/i, "").split(/\r?\n/);

  const exceptions: ExceptionInfo[] = [];
  let current: ExceptionInfo | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const frame = parseFrame(line, appPackages);
    if (frame && current) {
      current.frames.push(frame);
      continue;
    }
    if (line.trim().startsWith("...")) continue;
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
  }

  if (exceptions.length === 0) {
    const empty: ExceptionInfo = { type: "unknown", simpleType: "unknown", message: null, frames: [] };
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

  const appFrames: StackFrame[] = [
    ...deepestCause.frames.filter((f) => f.isAppCode),
    ...rootException.frames.filter((f) => f.isAppCode && deepestCause !== rootException),
  ];

  const culpritFrame =
    appFrames.find((f) => f.fileName && f.lineNumber !== null) ?? appFrames[0] ?? null;

  const { fixable, reason } = triage(deepestCause, culpritFrame, autoFixable, notAutoFixable);

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

/** Decide the CONFIDENCE label (not a gate — the agent attempts every crash). */
function triage(
  cause: ExceptionInfo,
  culprit: StackFrame | null,
  autoFixable: Set<string>,
  notAutoFixable: Set<string>,
): { fixable: boolean; reason: string } {
  const type = cause.type;
  if (notAutoFixable.has(type)) {
    return { fixable: false, reason: `${type} is typically systemic, not a single-file bug.` };
  }
  if (!culprit) {
    return { fixable: false, reason: "No app-owned frame found; crash is inside the SDK/framework." };
  }
  if (!autoFixable.has(type)) {
    return { fixable: false, reason: `${type} is not on the high-confidence allow-list; flag for human attention.` };
  }
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
