import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HitlClient, HitlApiError } from "@hitl/sdk";
import { config, log } from "./config.js";
import { waitForResolution } from "./waiter.js";

const client = new HitlClient({
  baseUrl: config.gatewayUrl,
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
});

const server = new McpServer({
  name: "hitl-approval-server",
  version: "0.1.0",
});

server.registerTool(
  "ask_human_permission",
  {
    title: "Ask a human for permission",
    description:
      "Pause the agent and ask a human operator to approve or deny a tool call via Telegram. " +
      "Blocks until the operator clicks Approve/Deny or the request expires.",
    inputSchema: {
      tool_name: z.string().describe("Name of the tool call that needs approval"),
      reason: z.string().optional().describe("Why this action needs human review"),
      payload: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Tool arguments; secrets are redacted before leaving the gateway"),
      kind: z
        .enum(["DECISION", "CHOICE", "QUESTION"])
        .optional()
        .describe("DECISION=approve/deny buttons, CHOICE=one of several options, QUESTION=free-text reply"),
      prompt: z
        .string()
        .max(2000)
        .optional()
        .describe("Question/prompt shown above the buttons (required for CHOICE/QUESTION)"),
      options: z
        .array(
          z.object({
            id: z.string().max(24).regex(/^[A-Za-z0-9_-]+$/),
            label: z.string().min(1).max(64),
            follow_up_prompt: z
              .string()
              .min(1)
              .max(500)
              .optional()
              .describe("If this option is picked, ask the operator this follow-up question"),
          }),
        )
        .min(2)
        .max(10)
        .optional()
        .describe("Options for CHOICE requests (rendered as inline buttons under the request message)"),
      thread_id: z
        .string()
        .optional()
        .describe("Workflow/thread identifier so related approvals can be correlated"),
      risk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
      ttl_seconds: z.number().int().min(30).max(86_400).optional(),
    },
  },
  async (input) => {
    try {
      const view = await client.createApproval({
        idempotencyKey: randomUUID(),
        agentId: config.agentId,
        threadId: input.thread_id ?? `mcp-${randomUUID()}`,
        toolName: input.tool_name,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.payload !== undefined ? { toolArgs: input.payload } : {}),
        ...(input.risk !== undefined ? { risk: input.risk } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.options !== undefined
          ? {
              options: input.options.map((option) => ({
                id: option.id,
                label: option.label,
                ...(option.follow_up_prompt !== undefined
                  ? { followUpPrompt: option.follow_up_prompt }
                  : {}),
              })),
            }
          : {}),
        ...(input.ttl_seconds !== undefined
          ? { ttlSeconds: input.ttl_seconds }
          : { ttlSeconds: config.defaultTtlSeconds }),
      });

      const resolved = await waitForResolution(client, view.shortId);
      const approved = resolved.status === "APPROVED" || resolved.status === "ANSWERED";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                shortId: resolved.shortId,
                kind: resolved.kind,
                status: resolved.status,
                approved,
                answer: resolved.answer,
                toolName: resolved.toolName,
                toolArgsHash: resolved.toolArgsHash,
                resolvedBy: resolved.resolvedByUsername ?? resolved.resolvedByTelegramId,
                resolvedAt: resolved.resolvedAt,
                reason: resolved.resolutionReason,
              },
              null,
              2,
            ),
          },
        ],
        ...(approved ? {} : { isError: true }),
      };
    } catch (error) {
      if (error instanceof HitlApiError) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: error.message,
                statusCode: error.statusCode,
                body: error.body,
              }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: (error as Error).message }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "notify_task_complete",
  {
    title: "Notify task completion",
    description: "Report that the agent finished the current task so operators can track it.",
    inputSchema: {
      summary: z.string().min(1).max(4000).describe("Short summary of what was accomplished"),
      thread_id: z.string().optional(),
    },
  },
  async (input) => {
    try {
      const response = await fetch(
        `${config.gatewayUrl.replace(/\/+$/, "")}/v1/notifications/task-complete`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { "x-api-key": config.apiKey } : {}),
          },
          body: JSON.stringify({
            agentId: config.agentId,
            threadId: input.thread_id ?? `mcp-${randomUUID()}`,
            summary: input.summary,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );

      const ok = response.ok;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok, status: response.status }),
          },
        ],
        ...(ok ? {} : { isError: true }),
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: (error as Error).message }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "send_operator_message",
  {
    title: "Send operator message",
    description:
      "Stream an interim update, progress note, or result to the human operator over Telegram. " +
      "Delivered only while remote mode is enabled on the gateway; otherwise acknowledged but not delivered.",
    inputSchema: {
      message: z.string().min(1).max(4000).describe("Plain-text message for the operator"),
      thread_id: z
        .string()
        .optional()
        .describe("Workflow/thread identifier; defaults to the active MCP thread"),
    },
  },
  async (input) => {
    try {
      const response = await fetch(
        `${config.gatewayUrl.replace(/\/+$/, "")}/v1/notifications/agent-message`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { "x-api-key": config.apiKey } : {}),
          },
          body: JSON.stringify({
            agentId: config.agentId,
            threadId: input.thread_id ?? "mcp-remote",
            message: input.message,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const body = (await response.json().catch(() => undefined)) as {
        delivered?: boolean;
        reason?: string;
      } | undefined;
      const delivered = body?.delivered === true;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: response.ok,
              delivered,
              status: response.status,
              ...(body?.reason ? { reason: body.reason } : {}),
            }),
          },
        ],
        ...(response.ok ? {} : { isError: true }),
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: (error as Error).message }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "check_operator_messages",
  {
    title: "Check operator messages",
    description:
      "Pull recent operator steering directives sent over Telegram (remote mode). " +
      "Call periodically during remote sessions to stay aligned with the operator.",
    inputSchema: {
      thread_id: z.string().optional().describe("Filter to a specific thread"),
      since: z
        .string()
        .optional()
        .describe("ISO timestamp; return only directives created after it"),
      limit: z.number().int().min(1).max(100).optional(),
      wait_seconds: z
        .number()
        .int()
        .min(0)
        .max(60)
        .optional()
        .describe("Long-poll: hold the request up to N seconds waiting for new directives"),
    },
  },
  async (input) => {
    try {
      const params = new URLSearchParams();
      if (input.thread_id) params.set("threadId", input.thread_id);
      if (input.since) params.set("since", input.since);
      if (input.limit) params.set("limit", String(input.limit));
      if (input.wait_seconds) params.set("waitSeconds", String(input.wait_seconds));
      const response = await fetch(
        `${config.gatewayUrl.replace(/\/+$/, "")}/v1/remote/messages?${params.toString()}`,
        {
          headers: config.apiKey ? { "x-api-key": config.apiKey } : {},
          signal: AbortSignal.timeout(10_000),
        },
      );
      const body: unknown = await response.json().catch(() => undefined);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ status: response.status, messages: body }, null, 2),
          },
        ],
        ...(response.ok ? {} : { isError: true }),
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: (error as Error).message }],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "mcp hitl server ready", { gateway: config.gatewayUrl });
}

main().catch((error) => {
  log("error", "mcp server failed", { err: (error as Error).message });
  process.exit(1);
});
