import { tool } from 'ai';
import { z } from 'zod';
import type { DB } from '../../db/db.js';
import {
  createSpace, addMember, removeMember, isMember,
  listSpacesForUser, listMembers, getSpaceByName,
} from '../../db/spaces.js';
import { listAllowlisted } from '../../db/users.js';

export function makeSpacesTool(db: DB, userId: number) {
  return tool({
    description:
      'Manage shared memory spaces. Actions: create a space, add an allowlisted person by name, ' +
      'list your spaces and their members, or leave a space. Facts shared to a space are visible to all its members.',
    inputSchema: z.object({
      action: z.enum(['create', 'add_member', 'list', 'leave']),
      name: z.string().optional().describe('Space name (required for create/add_member/leave)'),
      member: z.string().optional().describe('Name of the allowlisted person to add (add_member)'),
    }),
    execute: async ({ action, name, member }) => {
      if (action === 'list') {
        const spaces = listSpacesForUser(db, userId).map((s) => ({
          name: s.name,
          members: listMembers(db, s.id).map((u) => u.name ?? `user ${u.id}`),
        }));
        return { ok: true, spaces };
      }
      if (!name) return { ok: false, error: 'A space name is required.' };

      if (action === 'create') {
        createSpace(db, { name, createdBy: userId });
        return { ok: true };
      }

      const space = getSpaceByName(db, userId, name);
      if (!space) return { ok: false, error: `No space named "${name}" that you belong to.` };

      if (action === 'leave') {
        removeMember(db, space.id, userId);
        return { ok: true };
      }

      // add_member
      if (!member) return { ok: false, error: 'Which person should I add?' };
      const target = listAllowlisted(db).find(
        (u) => (u.name ?? '').toLowerCase() === member.toLowerCase(),
      );
      if (!target) return { ok: false, error: `No allowlisted person named "${member}".` };
      if (!isMember(db, space.id, userId)) return { ok: false, error: 'You are not a member of that space.' };
      addMember(db, space.id, target.id);
      return { ok: true };
    },
  });
}
