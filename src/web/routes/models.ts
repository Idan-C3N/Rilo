import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/db.js';
import { getConfig, setModels, setOpenrouterKey, getOpenrouterKey } from '../../db/config.js';
import { layout, esc, type Flash } from '../render.js';

const SAVED_FLASH: Record<string, Flash> = {
  models: { kind: 'ok', msg: 'Models saved ✅' },
  key: { kind: 'ok', msg: 'OpenRouter key saved ✅' },
};

export function registerModelsRoutes(app: FastifyInstance, db: DB): void {
  app.get<{ Querystring: { saved?: string } }>('/models', async (req, reply) => {
    const userId = (req as any).userId as number;
    const cfg = getConfig(db, userId);
    const hasKey = !!getOpenrouterKey(db, userId);
    const flash = req.query.saved ? SAVED_FLASH[req.query.saved] : undefined;
    reply.type('text/html').send(
      layout(
        'Models',
        `<div class="card"><h2>Models</h2>
        <form method="post" action="/models">
          <label>Cheap model<input name="cheap_model" value="${esc(cfg.cheap_model)}"></label>
          <label>Strong model<input name="strong_model" value="${esc(cfg.strong_model)}"></label>
          <button type="submit">Save models</button>
        </form></div>
        <div class="card"><h2>OpenRouter key</h2>
        <p>${hasKey ? 'Key is set ✅' : 'No key set ❌'}</p>
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
