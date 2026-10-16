import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const dispatchLatency = new Histogram({
  name: "hitl_dispatch_duration_seconds",
  help: "Time to dispatch a Telegram approval prompt",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const approvalsResolved = new Counter({
  name: "hitl_approvals_resolved_total",
  help: "Total approvals resolved by terminal status",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const resolutionLatency = new Histogram({
  name: "hitl_approval_resolution_seconds",
  help: "Seconds from approval creation to terminal resolution",
  buckets: [1, 5, 15, 30, 60, 120, 300, 900, 1800, 3600],
  registers: [registry],
});

export const resumeDeliveries = new Counter({
  name: "hitl_resume_deliveries_total",
  help: "Agent resume webhook delivery attempts by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const ttlPostponed = new Counter({
  name: "hitl_ttl_postponed_total",
  help: "TTL expiry postponements while remote mode is active",
  registers: [registry],
});
