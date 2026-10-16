import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const approvalsCreated = new Counter({
  name: "hitl_approvals_created_total",
  help: "Total approval requests created",
  labelNames: ["risk"] as const,
  registers: [registry],
});

export const remoteModeToggles = new Counter({
  name: "hitl_remote_mode_toggles_total",
  help: "Remote mode state transitions",
  labelNames: ["state"] as const,
  registers: [registry],
});

export const agentOutboundEnqueued = new Counter({
  name: "hitl_agent_outbound_enqueued_total",
  help: "Agent to Telegram outbound messages accepted for dispatch",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const approvalWebhookOutcomes = new Counter({
  name: "hitl_telegram_webhook_outcomes_total",
  help: "Telegram webhook CAS outcomes",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: "hitl_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});
