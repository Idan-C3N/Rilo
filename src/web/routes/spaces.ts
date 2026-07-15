import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import {
  listSpacesForUser, listMembers, createSpace,
  removeMember, isMember,
} from '../../db/spaces.js';
import { createInvite, listActiveInvites, redeemInvite } from '../../db/spaceInvites.js';
import { listSpaceFacts, forgetInSpace } from '../../db/memory.js';
import { getUserById } from '../../db/users.js';
import { layout, esc } from '../render.js';

export function registerSpacesRoutes(app: FastifyInstance, db: DB): void {
  const uidOf = (req: unknown) => (req as { userId: number }).userId;

  app.get('/spaces', async (req, reply) => {
    const uid = uidOf(req);
    const spaces = listSpacesForUser(db, uid);
    const cards = spaces
      .map((s) => {
        const members = listMembers(db, s.id).map((u) => esc(u.name ?? `user ${u.id}`)).join(', ');
        const facts = listSpaceFacts(db, s.id);
        const factRows = facts.length
          ? facts
              .map((m) => {
                const author = getUserById(db, m.user_id)?.name ?? `user ${m.user_id}`;
                return `<li>${esc(m.text)} <span class="muted">— added by ${esc(author)}</span>
                  <form method="post" action="/spaces/${s.id}/facts/${m.id}/delete" style="display:inline">
                    <button type="submit" class="secondary">Delete</button></form></li>`;
              })
              .join('')
          : '<li class="muted">No shared facts yet.</li>';
        const codes = listActiveInvites(db, s.id);
        const codeRows = codes.length
          ? codes.map((c) => `<li><code>${esc(c.code)}</code> <span class="muted">— expires ${new Date(c.expires_at).toISOString().slice(0, 10)}</span></li>`).join('')
          : '<li class="muted">No active invite codes.</li>';
        return `<section class="card"><h3>${esc(s.name)}</h3>
          <p class="muted">Members: ${members}</p>
          <ul>${factRows}</ul>
          <h4>Invite codes</h4>
          <p class="muted">Send a code to someone (already approved on this bot) — they redeem it to join. Single-use, expires in 7 days.</p>
          <ul>${codeRows}</ul>
          <form method="post" action="/spaces/${s.id}/invite" style="display:inline">
            <button type="submit">Generate another</button></form>
          <form method="post" action="/spaces/${s.id}/leave" style="display:inline">
            <button type="submit" class="secondary">Leave</button></form>
        </section>`;
      })
      .join('');
    const createForm = `<section class="card"><h2>Create a space</h2>
      <form method="post" action="/spaces">
        <input name="name" placeholder="e.g. Home" required>
        <button type="submit">Create</button></form></section>`;
    const redeemForm = `<section class="card"><h2>Join a space</h2>
      <form method="post" action="/spaces/redeem">
        <input name="code" placeholder="Invite code" required>
        <button type="submit">Redeem</button></form></section>`;
    reply.type('text/html').send(layout('Spaces', `${createForm}${redeemForm}${cards}`, { active: 'spaces' }));
  });

  app.post<{ Body: { name?: string } }>('/spaces', async (req, reply) => {
    const name = (req.body?.name ?? '').trim();
    if (name) {
      const space = createSpace(db, { name, createdBy: uidOf(req) });
      createInvite(db, { spaceId: space.id, createdBy: uidOf(req) }); // auto-mint first code
    }
    reply.redirect('/spaces');
  });

  app.post<{ Params: { id: string } }>('/spaces/:id/invite', async (req, reply) => {
    const uid = uidOf(req);
    const spaceId = Number(req.params.id);
    if (isMember(db, spaceId, uid)) createInvite(db, { spaceId, createdBy: uid });
    reply.redirect('/spaces');
  });

  app.post<{ Body: { code?: string } }>(
    '/spaces/redeem',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const code = (req.body?.code ?? '').trim().toUpperCase();
      if (code) redeemInvite(db, code, uidOf(req));
      reply.redirect('/spaces');
    },
  );

  app.post<{ Params: { id: string } }>('/spaces/:id/leave', async (req, reply) => {
    removeMember(db, Number(req.params.id), uidOf(req));
    reply.redirect('/spaces');
  });

  app.post<{ Params: { id: string; fid: string } }>('/spaces/:id/facts/:fid/delete', async (req, reply) => {
    const uid = uidOf(req);
    const spaceId = Number(req.params.id);
    // any member may delete a shared fact in a space they belong to, but the
    // deletion is scoped to that space so an arbitrary fid from elsewhere is a no-op
    if (isMember(db, spaceId, uid)) forgetInSpace(db, Number(req.params.fid), spaceId);
    reply.redirect('/spaces');
  });
}
