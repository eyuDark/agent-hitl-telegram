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
import { bot, choiceKeyboard, decisionKeyboard } from "../telegram.js";
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
      const topicThreadId = state.chatTopicId;
      if (!chatId) throw new Error(`Missing chatId for request ${shortId}`);

      const threadOptions = topicThreadId
        ? { message_thread_id: Number(topicThreadId) }
        : {};
      const baseOptions = { link_preview_options: { is_disabled: true } } as const;
      const stop = dispatchLatency.startTimer();
      let message;

      if (view.kind === "QUESTION") {
        message = await bot.api.sendMessage(chatId, text, {
          ...threadOptions,
          ...baseOptions,
        });
      } else if (view.kind === "CHOICE") {
        const options = parseOptions(state.options) ?? view.options ?? [];
        message = await bot.api.sendMessage(chatId, text, {
          ...threadOptions,
          reply_markup: choiceKeyboard(options, shortId),
          ...baseOptions,
        });
      } else {
        message = await bot.api.sendMessage(chatId, text, {
          ...threadOptions,
          reply_markup: decisionKeyboard(shortId),
          ...baseOptions,
        });
      }
      stop();

      await redis
        .multi()
        .hset(key, { messageId: String(message.message_id), originalText: text })
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
