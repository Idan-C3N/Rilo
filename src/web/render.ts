import { CSS } from './styles.js';

export type NavKey = 'home' | 'models' | 'services' | 'spaces' | 'reminders';
export interface Flash {
  kind: 'ok' | 'error';
  msg: string;
}

const NAV: Array<{ key: NavKey; href: string; label: string }> = [
  { key: 'home', href: '/', label: 'Home' },
  { key: 'models', href: '/models', label: 'Models' },
  { key: 'services', href: '/mcp', label: 'Services' },
  { key: 'spaces', href: '/spaces', label: 'Spaces' },
  { key: 'reminders', href: '/reminders', label: 'Reminders' },
];

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function navLink(href: string, label: string, active: boolean): string {
  return `<a href="${href}"${active ? ' class="active" aria-current="page"' : ''}>${esc(label)}</a>`;
}

export function flash(kind: 'ok' | 'error', msg: string): string {
  return `<div class="flash flash-${kind}">${esc(msg)}</div>`;
}

export function card(title: string, body: string): string {
  return `<section class="card"><h2>${esc(title)}</h2>${body}</section>`;
}

export function layout(
  title: string,
  body: string,
  opts: { active?: NavKey; flash?: Flash; bare?: boolean } = {},
): string {
  const nav = opts.bare
    ? ''
    : `<nav class="nav">${NAV.map((n) => navLink(n.href, n.label, opts.active === n.key)).join('')}<a href="/logout">Log out</a></nav>`;
  const flashHtml = opts.flash ? flash(opts.flash.kind, opts.flash.msg) : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <title>${esc(title)} · Rilo</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${CSS}</style>
  <script src="/vendor/htmx.min.js" defer></script></head>
  <body class="${opts.bare ? 'bare' : ''}">
  <header class="topbar"><div class="topbar-inner"><a class="brand" href="/">Rilo</a>${nav}</div></header>
  <main class="container">${flashHtml}${body}</main>
  </body></html>`;
}
