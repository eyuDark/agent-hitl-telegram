import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import {
  QUEUE_NAMES,
  type DispatchJobData,
  type ResumeJobData,
  type ResolutionJobData,
  type TtlJobData,
} from "@hitl/shared-types";

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  removeOnFail: { age: 604_800 },
};

export type GatewayQueues = {
  dispatch: Queue<DispatchJobData>;
  ttl: Queue<TtlJobData>;
  resolution: Queue<ResolutionJobData>;
  resume: Queue<ResumeJobData>;
};

export function createQueues(connection: Redis): GatewayQueues {
  return {
    dispatch: new Queue<DispatchJobData>(QUEUE_NAMES.dispatch, {
      connection,
      defaultJobOptions,
    }),
    ttl: new Queue<TtlJobData>(QUEUE_NAMES.ttl, {
      connection,
      defaultJobOptions,
    }),
    resolution: new Queue<ResolutionJobData>(QUEUE_NAMES.resolution, {
      connection,
      defaultJobOptions,
    }),
    resume: new Queue<ResumeJobData>(QUEUE_NAMES.resume, {
      connection,
      defaultJobOptions,
    }),
  };
}
