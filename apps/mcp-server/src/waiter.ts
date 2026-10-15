import { Redis } from "ioredis";
import {
  approvalEventSchema,
  isTerminal,
  redisKeys,
  type ApprovalView,
} from "@hitl/shared-types";
import { HitlClient, HitlTimeoutError } from "@hitl/sdk";
import { config } from "./config.js";

type WaitOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export async function waitForResolution(
  client: HitlClient,
  shortId: string,
  options: WaitOptions = {},
): Promise<ApprovalView> {
  const initial = await client.getApproval(shortId);
  if (!initial) {
    throw new Error(`Approval ${shortId} not found`);
  }
  if (isTerminal(initial.status)) return initial;

  const timeoutMs = options.timeoutMs ?? Date.parse(initial.expiresAt) - Date.now() + 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 3_000;
  const deadline = Date.now() + Math.max(1_000, timeoutMs);

  let settled = false;
  let subscriber: Redis | undefined;
  let pollTimer: NodeJS.Timeout | undefined;

  const finish = async (): Promise<ApprovalView | null> => {
    const current = await client.getApproval(shortId);
    return current && isTerminal(current.status) ? current : null;
  };

  try {
    const resolution = new Promise<ApprovalView | null>(async (resolve) => {
      if (config.redisUrl) {
        try {
          subscriber = new Redis(config.redisUrl, {
            maxRetriesPerRequest: 1,
            lazyConnect: true,
            enableOfflineQueue: true,
          });
          await subscriber.connect();
          subscriber.on("message", (channel, message) => {
            if (channel !== redisKeys.events(shortId)) return;
            try {
              const event = approvalEventSchema.parse(JSON.parse(message));
              if (isTerminal(event.status)) void resolve(finish());
            } catch {
              void resolve(finish());
            }
          });
          await subscriber.subscribe(redisKeys.events(shortId));
        } catch {
          subscriber = undefined;
        }
      }

      pollTimer = setInterval(() => {
        void finish().then((view) => {
          if (view) resolve(view);
        });
      }, pollIntervalMs);
    });

    const timer = new Promise<null>((resolve) => {
      const remaining = Math.max(0, deadline - Date.now());
      setTimeout(() => resolve(null), remaining).unref?.();
    });

    const result = await Promise.race([resolution, timer]);
    if (result) return result;

    const finalView = await finish();
    if (finalView) return finalView;
    throw new HitlTimeoutError(shortId, `Approval ${shortId} timed out while waiting`);
  } finally {
    if (pollTimer) clearInterval(pollTimer);
    if (subscriber) void subscriber.quit().catch(() => undefined);
  }
}
