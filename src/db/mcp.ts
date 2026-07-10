import type { DB } from './db.js';
import { encrypt, decrypt } from '../crypto/encryption.js';

export type McpTransport = 'stdio' | 'http' | 'sse';
export interface McpServer {
  id: number;
  user_id: number;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  creds?: Record<string, string>;
  enabled: boolean;
}

export interface McpInput {
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  creds?: Record<string, string>;
}

interface Row {
  id: number;
  user_id: number;
  name: string;
  transport: McpTransport;
  command: string | null;
  args_json: string;
  url: string | null;
  creds_enc: string | null;
  enabled: number;
}

function hydrate(r: Row): McpServer {
  return {
    id: r.id,
    user_id: r.user_id,
    name: r.name,
    transport: r.transport,
    command: r.command ?? undefined,
    args: JSON.parse(r.args_json),
    url: r.url ?? undefined,
    creds: r.creds_enc ? JSON.parse(decrypt(r.creds_enc)) : undefined,
    enabled: r.enabled === 1,
  };
}

export function addMcpServer(db: DB, userId: number, input: McpInput): number {
  const credsEnc = input.creds ? encrypt(JSON.stringify(input.creds)) : null;
  const info = db
    .prepare(
      'INSERT INTO mcp_servers (user_id, name, transport, command, args_json, url, creds_enc, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    )
    .run(userId, input.name, input.transport, input.command ?? null, JSON.stringify(input.args), input.url ?? null, credsEnc);
  return Number(info.lastInsertRowid);
}

export function listMcpServers(db: DB, userId: number): McpServer[] {
  return (db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY id').all(userId) as Row[]).map(hydrate);
}

export function listEnabledMcpServers(db: DB, userId: number): McpServer[] {
  return (db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? AND enabled = 1 ORDER BY id').all(userId) as Row[]).map(hydrate);
}

export function setMcpEnabled(db: DB, id: number, on: boolean): void {
  db.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(on ? 1 : 0, id);
}

export function deleteMcpServer(db: DB, id: number): void {
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}
