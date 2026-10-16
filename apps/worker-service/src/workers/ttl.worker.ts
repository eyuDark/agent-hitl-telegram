import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  approvalEventSchema,
  buildApprovalMessage,
  redisKeys,
  resolveApproval,
  resolutionStamp,
  type TtlJobData,
} from "@hitl/shared-types";
import type { Queue } from "bullmq";
import { prisma } from "../db.js";
import { bot } from "../telegram.js";
import { approvalsResolved } from "../metrics.js";
import { rowToView } from "../lib/views.js";

type TtlContext = {
  connection: Redis;
  resumeQueue: Queue<{ shortId: string }>;
};

export function createTtlWorker({ connection, resumeQueue }: TtlContext): Worker<TtlJobData> {
  return new Worker<TtlJobData>(
    "hitl-ttl-queue",
    async (job) => {
      const { shortId } = job.data;

      const outcome = await resolveApproval(
        connection,
        shortId,
        "EXPIRED",
        "SYSTEM_TTL",
        "ttl exceeded",
      );
      if (!outcome.ok) return;

      const key = redisKeys.request(shortId);
      const state = await connection.hgetall(key);
      const nowIso = new Date().toISOString();

      const row = await prisma.approval_requests
        .update({
          where: { short_id: shortId },
          data: {
            status: "EXPIRED",
            resolved_at: new Date(nowIso),
            resolution_reason: "ttl exceeded",
          },
        })
        .catch(() => null);

      const text =
        state.originalText ||
        (row
          ? buildApprovalMessage({ ...rowToView(row), status: "PENDING" })
          : `HITL Approval Request [${shortId}]`);

      if (state.messageId && state.chatId) {
        await bot.api
          .editMessageText(
            state.chatId,
            Number(state.messageId),
            `${text}\n\n${resolutionStamp("EXPIRED", "SYSTEM_TTL", nowIso)}`,
            { reply_markup: { inline_keyboard: [] } },
          )
          .catch(() => undefined);
      }

      if (state.chatId) {
        await connection
          .srem(redisKeys.chatIndex(String(state.chatId)), shortId)
          .catch(() => undefined);
      }

      await connection.publish(
        redisKeys.events(shortId),
        JSON.stringify(
          approvalEventSchema.parse({
            shortId,
            status: "EXPIRED",
            occurredAt: nowIso,
            actorId: "SYSTEM_TTL",
          }),
        ),
      );

      await resumeQueue.add(
        "resume-agent",
        { shortId },
        { jobId: `resume-${shortId}-EXPIRED` },
      );

      approvalsResolved.inc({ status: "EXPIRED" });
      job.log(`approval ${shortId} expired`);
    },
    { connection, concurrency: 5 },
  );
}
