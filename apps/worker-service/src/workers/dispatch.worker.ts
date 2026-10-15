import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  buildApprovalMessage,
  hashToView,
  redisKeys,
  type DispatchJobData,
  type RequestHashData,
} from "@hitl/shared-types";
import { prisma } from "../db.js";
import { bot, approvalKeyboard } from "../telegram.js";
import { dispatchLatency } from "../metrics.js";

export function createDispatchWorker(redis: Redis): Worker<DispatchJobData> {
  return new Worker<DispatchJobData>(
    "telegram-dispatch",
    async (job) => {
      const { shortId } = job.data;
      const key = redisKeys.request(shortId);
      const state = await redis.hgetall(key);

      if (!state.status || state.status !== "PENDING") return;
      if (state.messageId) return;

      const existing = await prisma.approval_requests.findUnique({
        where: { short_id: shortId },
        select: { telegram_message_id: true },
      });
      if (existing?.telegram_message_id) return;

      const view = hashToView(state as unknown as RequestHashData);
      const text = buildApprovalMessage(view);
      const chatId = state.chatId;
      if (!chatId) throw new Error(`Missing chatId for approval ${shortId}`);

      const stop = dispatchLatency.startTimer();
      const message = await bot.api.sendMessage(chatId, text, {
        reply_markup: approvalKeyboard(shortId),
        link_preview_options: { is_disabled: true },
      });
      stop();

      await redis.hset(key, {
        messageId: String(message.message_id),
        originalText: text,
      });
      await prisma.approval_requests
        .update({
          where: { short_id: shortId },
          data: { telegram_message_id: BigInt(message.message_id) },
        })
        .catch(() => undefined);

      job.log(`dispatched approval ${shortId} to chat ${chatId}`);
    },
    { connection: redis, concurrency: 5 },
  );
}
