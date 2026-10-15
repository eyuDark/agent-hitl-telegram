const SECRET_KEY_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|authorization|auth|credential|private[_-]?key|cvv|ssn)/i;

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

export function redactArgs(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.map((item) => redactArgs(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactArgs(item, depth + 1);
    }
    return out;
  }
  return value;
}
