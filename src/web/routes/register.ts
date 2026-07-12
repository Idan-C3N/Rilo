import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import { createRegistration } from '../../db/registrations.js';
import { layout, esc, flash } from '../render.js';

function formPage(errorMsg?: string): string {
  return layout(
    'Register',
    `<div class="card">
      <h2>Request access to Rilo</h2>
      <p class="muted">Enter your name and phone number. You'll finish verifying on Telegram.</p>
      ${errorMsg ? flash('error', errorMsg) : ''}
      <form method="post" action="/register">
        <label>Name<input name="name" autofocus></label>
        <label>Phone<input name="phone" inputmode="tel" placeholder="+972 50 123 4567"></label>
        <button type="submit">Continue</button>
      </form>
    </div>`,
    { bare: true },
  );
}

export function registerRegisterRoutes(
  app: FastifyInstance,
  db: DB,
  opts: { registrationLink: (code: string) => string },
): void {
  app.get('/register', async (_req, reply) => {
    reply.type('text/html').send(formPage());
  });

  app.post<{ Body: { name?: string; phone?: string } }>('/register', async (req, reply) => {
    const name = (req.body.name ?? '').trim();
    const phone = (req.body.phone ?? '').trim();
    if (!name || !phone) {
      reply.type('text/html').send(formPage('Please enter both your name and phone number.'));
      return;
    }
    const reg = createRegistration(db, { name, phone });
    const link = opts.registrationLink(reg.code);
    reply.type('text/html').send(
      layout(
        'Almost there',
        `<div class="card">
          <h2>One more step</h2>
          <p>Open Telegram to finish verifying your number:</p>
          <p><a href="${esc(link)}">${esc(link)}</a></p>
          <p class="muted">If the link doesn't open, start the bot and send:<br><code>/start ${esc(reg.code)}</code></p>
        </div>`,
        { bare: true },
      ),
    );
  });
}
