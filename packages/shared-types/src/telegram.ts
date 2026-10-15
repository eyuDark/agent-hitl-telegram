import type {
  Answer,
  ApprovalStatus,
  ApprovalView,
  ChoiceOption,
  RequestKind,
  RiskLevel,
} from "./schemas.js";

export type CallbackPayload =
  | { action: "approve"; shortId: string }
  | { action: "deny"; shortId: string }
  | { action: "choice"; shortId: string; index: number };

const SHORT_ID_ALPHABET = /^[A-Za-z0-9_-]{1,16}$/;

export function encodeDecisionCallback(action: "approve" | "deny", shortId: string): string {
  return `act:${action === "approve" ? "ap" : "dn"}:${shortId}`;
}

export function encodeChoiceCallback(shortId: string, index: number): string {
  return `act:o:${shortId}:${index}`;
}

export function decodeCallback(data: string | undefined): CallbackPayload | null {
  if (!data) return null;
  const parts = data.split(":");
  if (parts.length === 3) {
    const [prefix, code, shortId] = parts as [string, string, string];
    if (prefix !== "act" || !SHORT_ID_ALPHABET.test(shortId)) return null;
    if (code === "ap") return { action: "approve", shortId };
    if (code === "dn") return { action: "deny", shortId };
    return null;
  }
  if (parts.length === 4) {
    const [prefix, code, shortId, indexRaw] = parts as [string, string, string, string];
    if (prefix !== "act" || code !== "o" || !SHORT_ID_ALPHABET.test(shortId)) return null;
    if (!/^\d{1,2}$/.test(indexRaw)) return null;
    return { action: "choice", shortId, index: Number.parseInt(indexRaw, 10) };
  }
  return null;
}

export function buildApprovalMessage(view: ApprovalView): string {
  const header = `🔐 HITL ${kindLabel(view.kind)} Request [${view.shortId}]`;
  const details = [
    `Tool: ${view.toolName}`,
    `Risk: ${view.risk}`,
    `Agent: ${view.agentId}`,
    `Thread: ${view.threadId}`,
    view.reason ? `Reason: ${view.reason}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const expires = new Date(view.expiresAt).toISOString().replace(".000Z", "Z");
  const sections: string[] = [header, "", details];

  if (view.kind === "DECISION") {
    sections.push("", "Arguments (redacted):", truncate(safeStringify(view.toolArgsRedacted), 1200));
  }

  if (view.prompt) {
    sections.push("", "Prompt:", truncate(view.prompt, 1200));
  }

  if (view.kind === "CHOICE" && view.options) {
    sections.push(
      "",
      "Options:",
      ...view.options.map((option, index) => `${index + 1}. ${option.label}`),
    );
  }

  if (view.kind === "QUESTION") {
    sections.push("", "→ Reply directly to this message with your answer.");
  }

  sections.push("", `Expires: ${expires}`);
  return sections.join("\n");
}

export function buildResolvedMessage(view: ApprovalView, stamp: string): string {
  const base = buildApprovalMessage(view).replace("🔐 HITL", "📋 HITL");
  return `${base}\n\n${stamp}`;
}

export function resolutionStamp(
  status: ApprovalStatus,
  actorLabel: string,
  at: string,
  answer?: Answer | null,
): string {
  const time = new Date(at).toISOString().replace(".000Z", "Z");
  switch (status) {
    case "APPROVED":
      return `✅ APPROVED by ${actorLabel} at ${time}`;
    case "DENIED":
      return `❌ DENIED by ${actorLabel} at ${time}`;
    case "ANSWERED":
      return `💬 ANSWERED by ${actorLabel} at ${time}\nAnswer: ${answerSummary(answer)}`;
    case "EXPIRED":
      return `⏳ EXPIRED — auto-rejected due to timeout at ${time}`;
    case "CANCELLED":
      return `🚫 CANCELLED by ${actorLabel} at ${time}`;
    default:
      return `Status: ${status} at ${time}`;
  }
}

export function answerSummary(answer?: Answer | null): string {
  if (!answer) return "(no answer)";
  if (answer.type === "approval") return answer.decision;
  if (answer.type === "choice") {
    const base = `${answer.label} (${answer.optionId})`;
    return answer.followUpText ? `${base} — ${truncate(answer.followUpText, 200)}` : base;
  }
  return truncate(answer.text, 300);
}

export function choiceKeyboardRows(
  options: ChoiceOption[],
  shortId: string,
): { text: string; callback_data: string }[][] {
  return options.map((option, index) => ({
    text: `${index + 1}. ${option.label}`,
    callback_data: encodeChoiceCallback(shortId, index),
  })).map((button) => [button]);
}

export function parseAnswer(raw: string | undefined): Answer | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Answer;
  } catch {
    return null;
  }
}

export function parseOptions(raw: string | undefined): ChoiceOption[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ChoiceOption[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function riskLabel(risk: RiskLevel): string {
  return `#${risk}`;
}

function kindLabel(kind: RequestKind): string {
  switch (kind) {
    case "CHOICE":
      return "Choice";
    case "QUESTION":
      return "Question";
    default:
      return "Approval";
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}
