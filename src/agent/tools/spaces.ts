import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import {
  createSpace, removeMember, isMember,
  listSpacesForUser, listMembers, getSpaceByName,
} from '../../db/spaces.js';
import { createInvite, redeemInvite } from '../../db/spaceInvites.js';

export function makeSpacesTool(db: DB, userId: number) {
  return tool({
    description:
      'Manage shared memory spaces. Actions: create a space (returns an invite code to share), ' +
      'invite (generate a new single-use code for a space you belong to), redeem (join a space with a ' +
      'code someone sent you), list your spaces and members, or leave a space. Facts shared to a space ' +
      'are visible to all its members. To add someone, generate a code and send it to them — they redeem ' +
      'it; you never pick people from a list.',
    inputSchema: z.object({
      action: z.enum(['create', 'invite', 'redeem', 'list', 'leave']),
      name: z.string().optional().describe('Space name (required for create/invite/leave)'),
      code: z.string().optional().describe('Invite code (required for redeem)'),
    }),
    execute: async ({ action, name, code }) => {
      if (action === 'list') {
        const spaces = listSpacesForUser(db, userId).map((s) => ({
          name: s.name,
          members: listMembers(db, s.id).map((u) => u.name ?? `user ${u.id}`),
        }));
        return { ok: true, spaces };
      }

      if (action === 'redeem') {
        if (!code) return { ok: false, error: 'An invite code is required.' };
        return redeemInvite(db, code, userId);
      }

      if (!name) return { ok: false, error: 'A space name is required.' };

      if (action === 'create') {
        const space = createSpace(db, { name, createdBy: userId });
        const { code: inviteCode } = createInvite(db, { spaceId: space.id, createdBy: userId });
        return { ok: true, code: inviteCode };
      }

      const space = getSpaceByName(db, userId, name);
      if (!space) return { ok: false, error: `No space named "${name}" that you belong to.` };

      if (action === 'leave') {
        removeMember(db, space.id, userId);
        return { ok: true };
      }

      // invite
      if (!isMember(db, space.id, userId)) return { ok: false, error: 'You are not a member of that space.' };
      const { code: inviteCode } = createInvite(db, { spaceId: space.id, createdBy: userId });
      return { ok: true, code: inviteCode };
    },
  });
}
