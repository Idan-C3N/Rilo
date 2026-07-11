import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import { getConfig, setModels, setOpenrouterKey, getOpenrouterKey } from '../../db/config.js';
import { layout, esc, type Flash } from '../render.js';

const SAVED_FLASH: Record<string, Flash> = {
  models: { kind: 'ok', msg: 'Models saved ✅' },
  key: { kind: 'ok', msg: 'OpenRouter key saved ✅' },
};

function modelField(name: string, label: string, current: string, ids: string[]): string {
  if (ids.length === 0) {
    return `<label>${label}<input name="${name}" value="${esc(current)}"></label>`;
  }
  const opts = ids.includes(current) ? ids : [current, ...ids];
  const options = opts
    .map((id) => `<option value="${esc(id)}"${id === current ? ' selected' : ''}>${esc(id)}</option>`)
    .join('');
  return `<label>${label}<select name="${name}">${options}</select></label>`;
}

export function registerModelsRoutes(
  app: FastifyInstance,
  db: DB,
  getModels: () => Promise<string[]>,
): void {
  app.get<{ Querystring: { saved?: string } }>('/models', async (req, reply) => {
    const userId = (req as any).userId as number;
    const cfg = getConfig(db, userId);
    const hasKey = !!getOpenrouterKey(db, userId);
    const flash = req.query.saved ? SAVED_FLASH[req.query.saved] : undefined;
    const ids = await getModels();
    const note =
      ids.length === 0
        ? `<p class="muted">Couldn't load the model list — enter a slug manually.</p>`
        : '';
    reply.type('text/html').send(
      layout(
        'Models',
        `<div class="card"><h2>Models</h2>${note}
        <form method="post" action="/models">
          ${modelField('cheap_model', 'Cheap model', cfg.cheap_model, ids)}
          ${modelField('strong_model', 'Strong model', cfg.strong_model, ids)}
          <button type="submit">Save models</button>
        </form></div>
        <div class="card"><h2>OpenRouter key</h2>
        <p class="muted">${hasKey ? 'Your key is set ✅' : 'No personal key yet — the instance key is used as a fallback.'}</p>
        <form method="post" action="/openrouter-key">
          <label>API key<input name="key" type="password" placeholder="sk-or-..."></label>
          <button type="submit">Save key</button>
        </form></div>`,
        { active: 'models', flash },
      ),
    );
  });

  app.post<{ Body: { cheap_model: string; strong_model: string } }>('/models', async (req, reply) => {
    const userId = (req as any).userId as number;
    setModels(db, userId, { cheap_model: req.body.cheap_model, strong_model: req.body.strong_model });
    reply.redirect('/models?saved=models');
  });

  app.post<{ Body: { key: string } }>('/openrouter-key', async (req, reply) => {
    const userId = (req as any).userId as number;
    if (req.body.key) setOpenrouterKey(db, userId, req.body.key);
    reply.redirect('/models?saved=key');
  });
}
