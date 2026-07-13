import parser from 'cron-parser';

// Next occurrence of `cron` strictly after `after` (epoch ms), interpreted in
// timezone `tz`. Returns null if the expression is invalid or yields nothing.
export function nextFireAt(cron: string, tz: string, after: number): number | null {
  try {
    const interval = parser.parseExpression(cron, { currentDate: new Date(after), tz });
    return interval.next().toDate().getTime();
  } catch {
    return null;
  }
}

// Short human-readable label for a cron expression. cron-parser has no built-in
// English formatter, so we fall back to the raw expression — good enough for a
// management list where the user set the schedule themselves.
export function describeCron(cron: string): string {
  return cron;
}
