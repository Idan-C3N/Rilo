import type { ToolSet } from 'ai';
import type { DB } from '../../db/db.js';
import { makeRemindTool } from './remind.js';
import { makeRememberTool, makeRecallTool } from './memory.js';
import { makeTrackTool } from './track.js';
import { assembleMcpTools } from '../../mcp/manager.js';

export interface BuiltTools {
  tools: ToolSet;
  closeAll: () => Promise<void>;
}

export async function buildToolsFor(opts: {
  db: DB;
  userId: number;
  assemble?: (deps: { db: DB }, userId: number) => Promise<{ tools: ToolSet; closeAll: () => Promise<void> }>;
}): Promise<BuiltTools> {
  const { db, userId } = opts;
  const builtIn: ToolSet = {
    remind: makeRemindTool(db, userId),
    remember: makeRememberTool(db, userId),
    recall: makeRecallTool(db, userId),
    track: makeTrackTool(db, userId),
  };
  const assemble = opts.assemble ?? assembleMcpTools;
  const mcp = await assemble({ db }, userId);
  return {
    tools: { ...builtIn, ...mcp.tools },
    closeAll: mcp.closeAll,
  };
}
