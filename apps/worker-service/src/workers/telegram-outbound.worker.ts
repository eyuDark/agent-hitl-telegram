import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { OutboundJobData } from "@hitl/shared-types";
import { bot } from "../telegram.js";

const MAX_TELEGRAM_TEXT = 4096;

export function createOutboundWorker(redis: Redis): Worker<OutboundJobData> {
  return new Worker<OutboundJobData>(
    "hitl-telegram-outbound",
    async (job) => {
      const { chatId, topicId, agentId, threadId, message } = job.data;
      const body = message.slice(0, MAX_TELEGRAM_TEXT - 256);
      const text = `📨 ${agentId} · ${threadId}\n\n${body}`;

      await bot.api.sendMessage(chatId, text, {
        link_preview_options: { is_disabled: true },
        ...(topicId ? { message_thread_id: Number(topicId) } : {}),
      });

      job.log(`outbound message delivered to chat ${chatId}`);
    },
    { connection: redis, concurrency: 10 },
  );
}
