// Implements docs/v0.1-spec.md "Data privacy v0.1": raw tool results are NOT
// sent to the LLM unfiltered — this is the redact step in
// "Event Log -> filter -> redact -> LLM". Applied to every tool_calls.result_data
// blob before it goes into the prompt context, when the tenant's
// ai_data_policy isn't 'standard'.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Windows user-profile paths carry the username right in the path —
// C:\Users\<name>\... — redact the username segment specifically rather than
// the whole path, so "C:\Users\<redacted>\AppData\Local\Temp" still tells the
// model what it needs to know structurally.
const WINDOWS_USER_PATH_RE = /([A-Za-z]:\\Users\\)([^\\]+)/g;

export type AiDataPolicy = "standard" | "redacted" | "no_screenshots" | "no_raw_logs";

function redactString(value: string): string {
  return value
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(IPV4_RE, "[redacted-ip]")
    .replace(WINDOWS_USER_PATH_RE, "$1[redacted-user]");
}

/** Recursively redacts string values in an arbitrary JSON-like structure.
 * Keys are left alone (e.g. "hostname" stays "hostname") — only values are
 * scrubbed, since key names are structural, not user data. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v);
    return out;
  }
  return value;
}

/** policy === 'standard' means "no extra redaction beyond what tools already
 * omit by design" (e.g. process.list never had command lines to begin with —
 * see registry_windows.go). Every other policy value redacts. 'no_raw_logs'
 * additionally means eventlog.read results should be summarized rather than
 * passed through in full — not implemented yet since eventlog.read itself
 * isn't implemented on the agent side (see agent/README.md), flagged rather
 * than silently ignored. */
export function applyDataPolicy(policy: AiDataPolicy, resultData: unknown): unknown {
  if (policy === "standard") return resultData;
  return redactValue(resultData);
}
