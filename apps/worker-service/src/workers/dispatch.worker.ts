import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  buildApprovalMessage,
  hashToView,
  parseOptions,
  redisKeys,
  type DispatchJobData,
  type RequestHashData,
} from "@hitl/shared-types";
import { prisma } from "../db.js";
import { bot, decisionKeyboard, questionReplyMarkup, selectionKeyboard } from "../telegram.js";
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
      if (!chatId) throw new Error(`Missing chatId for request ${shortId}`);

      const stop = dispatchLatency.startTimer();
      let message;

      if (view.kind === "QUESTION") {
        message = await bot.api.sendMessage(chatId, text, {
          reply_markup: questionReplyMarkup(),
          link_preview_options: { is_disabled: true },
        });
      } else if (view.kind === "CHOICE") {
        const options = parseOptions(state.options) ?? view.options ?? [];
        message = await bot.api.sendMessage(chatId, text, {
          reply_markup: selectionKeyboard(options),
          link_preview_options: { is_disabled: true },
        });
      } else {
        message = await bot.api.sendMessage(chatId, text, {
          reply_markup: decisionKeyboard(shortId),
          link_preview_options: { is_disabled: true },
        });
      }
      stop();

      await redis
        .multi()
        .hset(key, { messageId: String(message.message_id), originalText: text })
        .set(redisKeys.messageIndex(chatId, message.message_id), shortId, "EX", 86_400)
        .sadd(redisKeys.chatIndex(chatId), shortId)
        .expire(redisKeys.chatIndex(chatId), 86_400)
        .exec();
      await prisma.approval_requests
        .update({
          where: { short_id: shortId },
          data: { telegram_message_id: BigInt(message.message_id) },
        })
        .catch(() => undefined);

      job.log(`dispatched ${view.kind} request ${shortId} to chat ${chatId}`);
    },
    { connection: redis, concurrency: 5 },
  );
}
