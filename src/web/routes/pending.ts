import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DB } from '../../db/db.js';
import { isOwner } from '../../db/users.js';
import { listPending, approveUser, denyUser } from '../../db/registrations.js';
import { layout, esc } from '../render.js';

export interface PendingDeps {
  /** Notify a requester over their channel when approved/denied (best-effort). */
  notify?: (channelUserId: string, text: string) => Promise<void>;
}

export function registerPendingRoutes(app: FastifyInstance, db: DB, deps: PendingDeps = {}): void {
  // Owner-only guard: the global preHandler already established req.userId.
  const requireOwner = (req: FastifyRequest, reply: FastifyReply): number | undefined => {
    const userId = (req as any).userId as number;
    if (!isOwner(db, userId)) {
      reply.code(403).type('text/html').send('Forbidden');
      return undefined;
    }
    return userId;
  };

  app.get('/users/pending', async (req, reply) => {
    if (requireOwner(req, reply) === undefined) return reply;
    const rows = listPending(db);
    const body = rows.length
      ? `<table class="table"><thead><tr><th>Name</th><th>Phone</th><th></th></tr></thead><tbody>${rows
          .map(
            (r) => `<tr>
              <td>${esc(r.name)}</td>
              <td class="muted">…${esc(r.phone.slice(-4))}</td>
              <td>
                <form method="post" action="/users/${r.user_id}/approve" style="display:inline">
                  <button type="submit">Approve</button>
                </form>
                <form method="post" action="/users/${r.user_id}/deny" style="display:inline">
                  <button type="submit" class="secondary">Deny</button>
                </form>
              </td>
            </tr>`,
          )
          .join('')}</tbody></table>`
      : '<p class="muted">No pending requests.</p>';
    reply.type('text/html').send(
      layout('Pending requests', `<section class="card"><h2>Pending requests</h2>${body}</section>`),
    );
  });

  app.post<{ Params: { id: string } }>('/users/:id/approve', async (req, reply) => {
    if (requireOwner(req, reply) === undefined) return reply;
    const reg = approveUser(db, Number(req.params.id)); // guard: only pending_approval
    if (reg?.channel_user_id) {
      await deps.notify?.(reg.channel_user_id, "You're in! Send /login to get started.");
    }
    reply.redirect('/users/pending');
  });

  app.post<{ Params: { id: string } }>('/users/:id/deny', async (req, reply) => {
    if (requireOwner(req, reply) === undefined) return reply;
    const reg = denyUser(db, Number(req.params.id));
    if (reg?.channel_user_id) {
      await deps.notify?.(reg.channel_user_id, 'Your access request was declined.');
    }
    reply.redirect('/users/pending');
  });
}
