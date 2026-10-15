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
        ...(input.ttl_seconds !== undefined
          ? { ttlSeconds: input.ttl_seconds }
          : { ttlSeconds: config.defaultTtlSeconds }),
      });

      const resolved = await waitForResolution(client, view.shortId);
      const approved = resolved.status === "APPROVED";

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                shortId: resolved.shortId,
                status: resolved.status,
                approved,
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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("info", "mcp hitl server ready", { gateway: config.gatewayUrl });
}

main().catch((error) => {
  log("error", "mcp server failed", { err: (error as Error).message });
  process.exit(1);
});
