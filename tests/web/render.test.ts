import { describe, it, expect } from 'vitest';
import { esc, layout, flash, card, navLink } from '../../src/web/render.js';

describe('render helpers', () => {
  it('esc escapes HTML-significant characters', () => {
    expect(esc(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('layout includes the title, inline CSS, and all nav links', () => {
    const html = layout('Models', '<p>hi</p>');
    expect(html).toContain('<title>Models · Rilo</title>');
    expect(html).toContain('<style>');
    expect(html).toContain('href="/"');        // Home
    expect(html).toContain('href="/models"');  // Models
    expect(html).toContain('href="/mcp"');      // Services
    expect(html).toContain('href="/logout"');   // Log out
    expect(html).toContain('<p>hi</p>');
  });

  it('layout marks the active nav item with aria-current', () => {
    const html = layout('Models', '', { active: 'models' });
    expect(html).toMatch(/<a href="\/models" class="active" aria-current="page">Models<\/a>/);
  });

  it('layout renders a flash banner when provided', () => {
    const html = layout('X', '', { flash: { kind: 'ok', msg: 'Saved' } });
    expect(html).toContain('<div class="flash flash-ok">Saved</div>');
  });

  it('bare layout omits the nav', () => {
    const html = layout('Login', '', { bare: true });
    expect(html).not.toContain('href="/models"');
  });

  it('flash escapes its message', () => {
    expect(flash('error', '<x>')).toBe('<div class="flash flash-error">&lt;x&gt;</div>');
  });

  it('card wraps body with an escaped title heading', () => {
    expect(card('A&B', '<p>x</p>')).toBe('<section class="card"><h2>A&amp;B</h2><p>x</p></section>');
  });
});
