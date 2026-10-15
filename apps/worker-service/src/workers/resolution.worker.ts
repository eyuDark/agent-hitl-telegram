import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  approvalEventSchema,
  buildResolvedMessage,
  redisKeys,
  resolutionStamp,
  type ResolutionJobData,
} from "@hitl/shared-types";
import type { Queue } from "bullmq";
import { prisma } from "../db.js";
import { bot } from "../telegram.js";
import { approvalsResolved, resolutionLatency } from "../metrics.js";
import { rowToView } from "../lib/views.js";

type ResolutionContext = {
  connection: Redis;
  resumeQueue: Queue<{ shortId: string }>;
};

export function createResolutionWorker({
  connection,
  resumeQueue,
}: ResolutionContext): Worker<ResolutionJobData> {
  return new Worker<ResolutionJobData>(
    "hitl-resolution-queue",
    async (job) => {
      const { shortId, newStatus, actorId, actorUsername, resolvedAt, reason } = job.data;

      const row = await prisma.approval_requests.findUnique({ where: { short_id: shortId } });
      if (!row) {
        job.log(`approval ${shortId} missing from ledger, skipping`);
        return;
      }

      await prisma.approval_requests
        .update({
          where: { short_id: shortId },
          data: {
            status: newStatus,
            resolved_by_telegram_id: actorId === "AGENT" || actorId === "SYSTEM_TTL" ? null : BigInt(actorId),
            resolved_by_username: actorUsername,
            resolution_reason: reason,
            resolved_at: new Date(resolvedAt),
          },
        })
        .catch(() => undefined);

      const view = rowToView({ ...row, status: newStatus, resolved_at: new Date(resolvedAt) });
      const actorLabel = actorUsername ? `@${actorUsername}` : actorId;
      const stamp = resolutionStamp(newStatus, actorLabel, resolvedAt);
      const key = redisKeys.request(shortId);
      const state = await connection.hgetall(key);

      await connection
        .hset(key, {
          status: newStatus,
          actorId,
          actorUsername: actorUsername ?? "",
          resolvedAt,
          resolutionReason: reason ?? "",
        })
        .catch(() => undefined);

      if (state.messageId && state.chatId) {
        await bot.api
          .editMessageText(
            state.chatId,
            Number(state.messageId),
            buildResolvedMessage(view, stamp),
            { reply_markup: { inline_keyboard: [] } },
          )
          .catch((error) => job.log(`edit failed: ${(error as Error).message}`));
      }

      await connection.publish(
        redisKeys.events(shortId),
        JSON.stringify(
          approvalEventSchema.parse({
            shortId,
            status: newStatus,
            occurredAt: resolvedAt,
            actorId,
            ...(actorUsername ? { actorUsername } : {}),
          }),
        ),
      );

      await resumeQueue.add(
        "resume-agent",
        { shortId },
        { jobId: `resume-${shortId}-${newStatus}` },
      );

      const latencySeconds = (Date.parse(resolvedAt) - row.created_at.getTime()) / 1000;
      if (latencySeconds >= 0) resolutionLatency.observe(latencySeconds);
      approvalsResolved.inc({ status: newStatus });

      job.log(`approval ${shortId} resolved as ${newStatus}`);
    },
    { connection, concurrency: 5 },
  );
}
