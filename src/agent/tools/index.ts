import type { ToolSet } from 'ai';
import type { DB } from '../../db/db.js';
import { makeRemindTool } from './remind.js';

export async function buildToolsFor(opts: { db: DB; userId: number }): Promise<ToolSet> {
  const { db, userId } = opts;
  return {
    remind: makeRemindTool(db, userId),
  };
}
