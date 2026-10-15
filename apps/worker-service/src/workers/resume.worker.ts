import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { agentResumePayloadSchema, signPayload, type ResumeJobData } from "@hitl/shared-types";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { resumeDeliveries } from "../metrics.js";

export function createResumeWorker(connection: Redis): Worker<ResumeJobData> {
  return new Worker<ResumeJobData>(
    "agent-resume-queue",
    async (job) => {
      const { shortId } = job.data;
      const row = await prisma.approval_requests.findUnique({ where: { short_id: shortId } });

      if (!row) {
        resumeDeliveries.inc({ outcome: "missing_ledger" });
        return;
      }
      if (!row.callback_url) {
        resumeDeliveries.inc({ outcome: "no_callback" });
        return;
      }

      const payload = agentResumePayloadSchema.parse({
        shortId: row.short_id,
        status: row.status,
        kind: row.kind,
        agentId: row.agent_id,
        threadId: row.thread_id,
        toolName: row.tool_name,
        toolArgsHash: row.tool_args_hash,
        answer: row.answer_json,
        reason: row.reason,
        resolvedBy:
          row.resolved_by_telegram_id === null ? null : String(row.resolved_by_telegram_id),
        resolvedByUsername: row.resolved_by_username,
        resolutionReason: row.resolution_reason,
        resolvedAt: (row.resolved_at ?? row.created_at).toISOString(),
      });

      const rawBody = JSON.stringify(payload);
      const response = await fetch(row.callback_url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hitl-signature": signPayload(rawBody, config.hmacSecret),
          "idempotency-key": `hitl-resume:${row.short_id}`,
        },
        body: rawBody,
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        resumeDeliveries.inc({ outcome: "http_error" });
        throw new Error(`Resume callback responded ${response.status}`);
      }

      resumeDeliveries.inc({ outcome: "delivered" });
      job.log(`resume delivered for ${shortId}`);
    },
    { connection, concurrency: 10 },
  );
}
