import type { ToolSet } from 'ai';
import type { DB } from '../../db/db.js';
import { makeRemindTool } from './remind.js';
import { makeRememberTool, makeRecallTool } from './memory.js';
import type { Embedder } from '../embeddings.js';
import { makeTrackTool } from './track.js';
import { makeSpacesTool } from './spaces.js';
import { makeWebSearchTool, tavilySearch, type SearchFn } from './websearch.js';
import { makeGoogleTools } from './google.js';
import { makeGoogleTokenProvider } from '../google/client.js';
import { hasOAuthToken, getOAuthToken } from '../../db/oauth.js';
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
  // Instance-level Google OAuth app credentials; Google tools are added only
  // when these are set AND the user has connected (stored a refresh token).
  google?: { clientId: string; clientSecret: string };
  // Optional embedding backend; when present, memory tools use semantic recall.
  embed?: Embedder;
  assemble?: (deps: { db: DB }, userId: number) => Promise<{ tools: ToolSet; closeAll: () => Promise<void> }>;
}): Promise<BuiltTools> {
  const { db, userId } = opts;
  const builtIn: ToolSet = {
    remind: makeRemindTool(db, userId),
    remember: makeRememberTool(db, userId, opts.embed),
    recall: makeRecallTool(db, userId, opts.embed),
    track: makeTrackTool(db, userId),
    spaces: makeSpacesTool(db, userId),
  };
  const search = opts.search ?? (opts.webSearchKey ? tavilySearch(opts.webSearchKey) : undefined);
  if (search) {
    builtIn.web_search = makeWebSearchTool(search);
  }
  if (opts.google && hasOAuthToken(db, userId, 'google')) {
    const refreshToken = getOAuthToken(db, userId, 'google')!;
    const getToken = makeGoogleTokenProvider(opts.google.clientId, opts.google.clientSecret, refreshToken);
    Object.assign(builtIn, makeGoogleTools({ getToken }));
  }
  const assemble = opts.assemble ?? assembleMcpTools;
  const mcp = await assemble({ db }, userId);
  return {
    tools: { ...builtIn, ...mcp.tools },
    closeAll: mcp.closeAll,
  };
}
