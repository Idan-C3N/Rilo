import type { ToolSet } from 'ai';
import type { DB } from '../../db/db.js';
import { makeRemindTool } from './remind.js';
import { makeRememberTool, makeRecallTool } from './memory.js';
import { makeTrackTool } from './track.js';
import { makeWebSearchTool, tavilySearch, type SearchFn } from './websearch.js';
import { assembleMcpTools } from '../../mcp/manager.js';

export interface BuiltTools {
  tools: ToolSet;
  closeAll: () => Promise<void>;
}

export async function buildToolsFor(opts: {
  db: DB;
  userId: number;
  // Web search is only offered when a backend is available (a Tavily API key,
  // or an injected search fn in tests). Absent → the tool simply isn't present.
  webSearchKey?: string;
  search?: SearchFn;
  assemble?: (deps: { db: DB }, userId: number) => Promise<{ tools: ToolSet; closeAll: () => Promise<void> }>;
}): Promise<BuiltTools> {
  const { db, userId } = opts;
  const builtIn: ToolSet = {
    remind: makeRemindTool(db, userId),
    remember: makeRememberTool(db, userId),
    recall: makeRecallTool(db, userId),
    track: makeTrackTool(db, userId),
  };
  const search = opts.search ?? (opts.webSearchKey ? tavilySearch(opts.webSearchKey) : undefined);
  if (search) {
    builtIn.web_search = makeWebSearchTool(search);
  }
  const assemble = opts.assemble ?? assembleMcpTools;
  const mcp = await assemble({ db }, userId);
  return {
    tools: { ...builtIn, ...mcp.tools },
    closeAll: mcp.closeAll,
  };
}
