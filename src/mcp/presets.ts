import type { McpTransport } from '../db/mcp.js';

/**
 * A secret the preset needs from the user. Its value is stored in the server's
 * creds map under `field` — which becomes an ENV var (stdio) or an HTTP header
 * (http/sse) when the MCP client is started.
 */
export interface PresetSecret {
  field: string;
  label: string;
  placeholder?: string;
}

/**
 * A one-click MCP server definition. The transport/command/url are baked in so
 * the user only supplies the secret(s). stdio presets launch via `npx -y` on
 * the host (no manual install).
 */
export interface McpPreset {
  id: string;
  label: string;
  description: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  secrets: PresetSecret[];
}

// Deliberately tiny to start — validate the flow, then grow the catalog.
export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'slack',
    label: 'Slack',
    description:
      'Read/search/send Slack messages. Create a Slack app, add bot scopes, install it to your workspace, then paste the Bot token (xoxb-…) and your workspace/team ID (T…).',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    secrets: [
      { field: 'SLACK_BOT_TOKEN', label: 'Bot token', placeholder: 'xoxb-...' },
      { field: 'SLACK_TEAM_ID', label: 'Workspace/Team ID', placeholder: 'T0123ABC' },
    ],
  },
];

export function getPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((p) => p.id === id);
}
