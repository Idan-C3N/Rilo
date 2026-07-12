import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import {
  listSpacesForUser, listMembers, createSpace,
  addMember, removeMember, isMember,
} from '../../db/spaces.js';
import { recall, forget } from '../../db/memory.js';
import { listAllowlisted, getUserById } from '../../db/users.js';
import { layout, esc } from '../render.js';

export function registerSpacesRoutes(app: FastifyInstance, db: DB): void {
  const uidOf = (req: unknown) => (req as { userId: number }).userId;

  app.get('/spaces', async (req, reply) => {
    const uid = uidOf(req);
    const spaces = listSpacesForUser(db, uid);
    const allowlisted = listAllowlisted(db);
    const cards = spaces
      .map((s) => {
        const members = listMembers(db, s.id).map((u) => esc(u.name ?? `user ${u.id}`)).join(', ');
        // shared facts in this space = recall rows whose space_id === s.id
        const facts = recall(db, uid).filter((m) => m.space_id === s.id);
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
        const options = allowlisted
          .map((u) => `<option value="${esc(u.name ?? String(u.id))}">`)
          .join('');
        return `<section class="card"><h3>${esc(s.name)}</h3>
          <p class="muted">Members: ${members}</p>
          <ul>${factRows}</ul>
          <form method="post" action="/spaces/${s.id}/members" style="display:inline">
            <input name="member" list="allowlisted-${s.id}" placeholder="Add person by name" required>
            <datalist id="allowlisted-${s.id}">${options}</datalist>
            <button type="submit">Add member</button></form>
          <form method="post" action="/spaces/${s.id}/leave" style="display:inline">
            <button type="submit" class="secondary">Leave</button></form>
        </section>`;
      })
      .join('');
    const createForm = `<section class="card"><h2>Create a space</h2>
      <form method="post" action="/spaces">
        <input name="name" placeholder="e.g. Home" required>
        <button type="submit">Create</button></form></section>`;
    reply.type('text/html').send(layout('Spaces', `${createForm}${cards}`, { active: 'spaces' }));
  });

  app.post<{ Body: { name?: string } }>('/spaces', async (req, reply) => {
    const name = (req.body?.name ?? '').trim();
    if (name) createSpace(db, { name, createdBy: uidOf(req) });
    reply.redirect('/spaces');
  });

  app.post<{ Params: { id: string }; Body: { member?: string } }>('/spaces/:id/members', async (req, reply) => {
    const uid = uidOf(req);
    const spaceId = Number(req.params.id);
    if (isMember(db, spaceId, uid)) {
      const name = (req.body?.member ?? '').trim().toLowerCase();
      const target = listAllowlisted(db).find((u) => (u.name ?? '').toLowerCase() === name);
      if (target) addMember(db, spaceId, target.id);
    }
    reply.redirect('/spaces');
  });

  app.post<{ Params: { id: string } }>('/spaces/:id/leave', async (req, reply) => {
    removeMember(db, Number(req.params.id), uidOf(req));
    reply.redirect('/spaces');
  });

  app.post<{ Params: { id: string; fid: string } }>('/spaces/:id/facts/:fid/delete', async (req, reply) => {
    const uid = uidOf(req);
    const spaceId = Number(req.params.id);
    // any member may delete a shared fact in a space they belong to
    if (isMember(db, spaceId, uid)) forget(db, Number(req.params.fid));
    reply.redirect('/spaces');
  });
}
