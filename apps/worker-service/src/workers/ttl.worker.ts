import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  approvalEventSchema,
  buildApprovalMessage,
  getRemoteMode,
  isRemoteModeOn,
  redisKeys,
  resolutionStamp,
  resolveApproval,
  type TtlJobData,
  type TtlRemoteAuditJobData,
} from "@hitl/shared-types";
import type { Queue } from "bullmq";
import { prisma } from "../db.js";
import { bot } from "../telegram.js";
import { config } from "../config.js";
import { approvalsResolved, ttlPostponed } from "../metrics.js";
import { rowToView } from "../lib/views.js";

type TtlContext = {
  connection: Redis;
  resumeQueue: Queue<{ shortId: string }>;
  ttlQueue: Queue<TtlJobData>;
};

export function createTtlWorker({
  connection,
  resumeQueue,
  ttlQueue,
}: TtlContext): Worker<TtlJobData> {
  return new Worker<TtlJobData>(
    "hitl-ttl-queue",
    async (job) => {
      if (job.name === "remote-audit") {
        const audit = job.data as TtlRemoteAuditJobData;
        const current = await getRemoteMode(connection);
        // a newer enable superseded this audit — never close someone else's live session
        if (current.enabled && current.enabledAt !== null && current.enabledAt >= audit.enabledAt) {
          return;
        }

        const closePromises = [
          audit.topicId
            ? bot.api.closeForumTopic(audit.chatId, Number(audit.topicId)).catch(() => undefined)
            : Promise.resolve(),
          audit.topicId
            ? connection.del(redisKeys.remoteTopicMap(audit.chatId, audit.topicId)).catch(() => undefined)
            : Promise.resolve(),
          connection
            .hset(
              redisKeys.remoteSession(audit.agentId ?? "remote", audit.threadId ?? "session"),
              { status: "CLOSED", disabledAt: new Date().toISOString() },
            )
            .catch(() => undefined),
          bot.api
            .sendMessage(
              audit.chatId,
              `🛰 Remote session ended (24h dead-man TTL) — topic closed.`,
              {
                link_preview_options: { is_disabled: true },
                ...(audit.topicId ? { message_thread_id: Number(audit.topicId) } : {}),
              },
            )
            .catch(() => undefined),
        ];
        await Promise.all(closePromises);
        job.log("remote audit — flag silent past TTL, closed session");
        return;
      }

      const { shortId } = job.data as Extract<TtlJobData, { shortId: string }>;

      if (await isRemoteModeOn(connection)) {
        const postponed =
          ((job.data as Extract<TtlJobData, { shortId: string }>).postponed ?? 0) + 1;
        ttlPostponed.inc();
        await ttlQueue.add(
          "recheck-ttl",
          { shortId, postponed },
          {
            jobId: `ttl-${shortId}-p${postponed}`,
            delay: config.remoteTtlRecheckSeconds * 1000,
          },
        );
        job.log(`remote mode active — postponed expiry re-check ${postponed} for ${shortId}`);
        return;
      }

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
