export function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body{font-family:system-ui;max-width:640px;margin:2rem auto;padding:0 1rem}
  input,button{font-size:1rem;padding:.4rem;margin:.2rem 0}label{display:block;margin-top:.8rem}
  .card{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}
  nav a{margin-right:1rem}</style></head>
  <body><nav><a href="/">Models</a><a href="/mcp">Services</a></nav>${body}</body></html>`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
