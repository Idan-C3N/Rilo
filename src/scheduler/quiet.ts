export interface QuietWindow {
  tz: string;
  quiet_start: number;
  quiet_end: number;
}

export function isQuiet(u: QuietWindow, atMs: number): boolean {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: u.tz,
    hour: 'numeric',
    hour12: false,
  }).format(new Date(atMs));
  // "24" can appear for midnight in some environments; normalize to 0
  const hour = Number(hourStr) % 24;
  const { quiet_start: s, quiet_end: e } = u;
  if (s === e) return false;
  if (s < e) return hour >= s && hour < e;
  return hour >= s || hour < e; // wrap-around
}
