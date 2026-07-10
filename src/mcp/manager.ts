import type { ToolSet } from 'ai';
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { DB } from '../db/db.js';
import { listEnabledMcpServers, type McpServer } from '../db/mcp.js';

export interface McpClientLike {
  tools(): Promise<ToolSet>;
  close(): Promise<void>;
}

export interface ManagerDeps {
  db: DB;
  makeClient?: (server: McpServer) => Promise<McpClientLike>;
}

export async function defaultMakeClient(server: McpServer): Promise<McpClientLike> {
  if (server.transport === 'stdio') {
    // Stdio transport is a class from the @ai-sdk/mcp/mcp-stdio subpath (the
    // config-object form of createMCPClient only supports http/sse).
    const transport = new Experimental_StdioMCPTransport({
      command: server.command!,
      args: server.args,
      env: server.creds,
    });
    return (await createMCPClient({ transport })) as unknown as McpClientLike;
  }
  // http or sse via the config-object transport form
  return (await createMCPClient({
    transport: { type: server.transport, url: server.url!, headers: server.creds },
  })) as unknown as McpClientLike;
}

export async function assembleMcpTools(
  deps: ManagerDeps,
  userId: number,
): Promise<{ tools: ToolSet; closeAll: () => Promise<void> }> {
  const make = deps.makeClient ?? defaultMakeClient;
  const clients: McpClientLike[] = [];
  const tools: ToolSet = {};

  for (const server of listEnabledMcpServers(deps.db, userId)) {
    try {
      const client = await make(server);
      clients.push(client);
      const serverTools = await client.tools();
      for (const [toolName, def] of Object.entries(serverTools)) {
        tools[`${server.name}__${toolName}`] = def;
      }
    } catch (err) {
      console.error(`MCP server "${server.name}" unavailable, skipping:`, err);
    }
  }

  return {
    tools,
    closeAll: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
