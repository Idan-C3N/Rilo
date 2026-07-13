import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import { listRecurring, cancelJob } from '../../db/jobs.js';
import { describeCron } from '../../scheduler/recurrence.js';
import { layout, esc } from '../render.js';

export function registerRemindersRoutes(app: FastifyInstance, db: DB): void {
  const uidOf = (req: unknown) => (req as { userId: number }).userId;

  app.get('/reminders', async (req, reply) => {
    const uid = uidOf(req);
    const reminders = listRecurring(db, uid);
    const rows = reminders.length
      ? reminders
          .map((j) => {
            const text = esc(String(j.payload.text ?? '(reminder)'));
            const cap =
              j.recurrence_count != null ? ` · ${j.recurrence_count} left`
              : j.recurrence_until != null ? ` · until ${new Date(j.recurrence_until).toISOString()}`
              : '';
            return `<li>${text} <span class="muted">— ${esc(describeCron(j.recurrence!))}${esc(cap)}</span>
              <form method="post" action="/reminders/${j.id}/cancel" style="display:inline">
                <button type="submit" class="secondary">Cancel</button></form></li>`;
          })
          .join('')
      : '<li class="muted">No repeating reminders yet.</li>';
    const body = `<section class="card"><h2>Repeating reminders</h2><ul>${rows}</ul></section>`;
    reply.type('text/html').send(layout('Reminders', body, { active: 'reminders' }));
  });

  app.post<{ Params: { id: string } }>('/reminders/:id/cancel', async (req, reply) => {
    const uid = uidOf(req);
    const id = Number(req.params.id);
    // Ownership gate: only cancel an id that belongs to this user's active recurring reminders.
    if (listRecurring(db, uid).some((j) => j.id === id)) cancelJob(db, id);
    reply.redirect('/reminders');
  });
}
