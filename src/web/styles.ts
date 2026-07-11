export const CSS = `
:root{
  --bg:#f7f8fa; --surface:#fff; --border:#e3e6ea; --text:#1a1d21; --muted:#6b7280;
  --accent:#2563eb; --accent-text:#fff; --danger:#dc2626;
  --radius:10px; --shadow:0 1px 2px rgba(0,0,0,.04),0 1px 3px rgba(0,0,0,.06);
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0f1115; --surface:#171a21; --border:#2a2f39; --text:#e6e8eb; --muted:#9aa4b2;
    --accent:#3b82f6; --accent-text:#fff; --danger:#f87171;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 1px 3px rgba(0,0,0,.4);
  }
}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:var(--bg);color:var(--text);line-height:1.5}
header.topbar{background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}
.topbar-inner{max-width:720px;margin:0 auto;padding:.75rem 1rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
.brand{font-weight:700;font-size:1.1rem;color:var(--text);text-decoration:none;margin-right:auto}
nav.nav{display:flex;gap:.25rem;flex-wrap:wrap}
nav.nav a{color:var(--muted);text-decoration:none;padding:.35rem .6rem;border-radius:8px;font-size:.95rem}
nav.nav a:hover{background:var(--bg);color:var(--text)}
nav.nav a.active{color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent);font-weight:600}
main.container{max-width:720px;margin:0 auto;padding:1.5rem 1rem 3rem}
body.bare main.container{min-height:80vh;display:grid;place-items:center}
body.bare main.container>*{width:100%;max-width:380px}
h1{font-size:1.5rem;margin:0 0 1rem}
h2{font-size:1.15rem;margin:0 0 .75rem}
h3{font-size:1rem;margin:0 0 .5rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  box-shadow:var(--shadow);padding:1.25rem;margin:0 0 1.25rem}
label{display:block;margin:0 0 .8rem;font-size:.9rem;color:var(--muted)}
input,select,textarea{display:block;width:100%;margin-top:.3rem;font:inherit;color:var(--text);
  background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:.5rem .6rem}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);
  outline-offset:1px;border-color:var(--accent)}
button,.btn{font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;
  padding:.5rem .9rem;font-weight:600;background:var(--accent);color:var(--accent-text)}
button:hover,.btn:hover{filter:brightness(1.05)}
.btn-secondary{background:var(--surface);color:var(--text);border-color:var(--border)}
.btn-danger{background:transparent;color:var(--danger);border-color:var(--border)}
form{margin:0}
.inline-form{display:inline;margin-right:.4rem}
.flash{padding:.6rem .9rem;border-radius:8px;margin:0 0 1.25rem;font-size:.95rem;border:1px solid transparent}
.flash-ok{background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent);
  border-color:color-mix(in srgb,var(--accent) 30%,transparent)}
.flash-error{background:color-mix(in srgb,var(--danger) 12%,transparent);color:var(--danger);
  border-color:color-mix(in srgb,var(--danger) 30%,transparent)}
.muted{color:var(--muted)}
.status-row{display:flex;align-items:center;gap:.5rem;padding:.7rem 0;border-bottom:1px solid var(--border)}
.status-row:last-child{border-bottom:0}
.status-row .label{font-weight:600}
.status-row .spacer{margin-left:auto}
.empty{text-align:center;color:var(--muted);padding:2rem 1rem}
code{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:.1rem .35rem;font-size:.85em}
details summary{cursor:pointer;color:var(--muted);margin:.5rem 0}
a{color:var(--accent)}
`;
