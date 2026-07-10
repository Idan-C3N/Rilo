import type { ToolSet } from 'ai';
import type { DB } from '../../db/db.js';
import { makeRemindTool } from './remind.js';
import { makeRememberTool, makeRecallTool } from './memory.js';
import { makeTrackTool } from './track.js';

export async function buildToolsFor(opts: { db: DB; userId: number }): Promise<ToolSet> {
  const { db, userId } = opts;
  return {
    remind: makeRemindTool(db, userId),
    remember: makeRememberTool(db, userId),
    recall: makeRecallTool(db, userId),
    track: makeTrackTool(db, userId),
  };
}
