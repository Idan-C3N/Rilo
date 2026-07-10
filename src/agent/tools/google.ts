import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { TokenProvider } from '../google/client.js';

export interface GoogleDeps {
  getToken: TokenProvider;
  fetchImpl?: typeof fetch;
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';

/** Authenticated JSON call to a Google REST endpoint. Throws on non-2xx. */
function apiCall(deps: GoogleDeps) {
  const f = deps.fetchImpl ?? fetch;
  return async (url: string, init?: RequestInit): Promise<any> => {
    const token = await deps.getToken();
    const res = await f(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`Google API ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  };
}

function header(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Walk a Gmail payload tree for the first text/plain body. */
function extractBody(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeB64Url(payload.body.data);
  for (const part of payload.parts ?? []) {
    const b = extractBody(part);
    if (b) return b;
  }
  if (payload.body?.data) return decodeB64Url(payload.body.data);
  return '';
}

export function makeGoogleTools(deps: GoogleDeps): ToolSet {
  const call = apiCall(deps);

  const gmail_search = tool({
    description: 'Search the user\'s Gmail. Returns matching messages with sender, subject, date, and snippet. Use Gmail search syntax in the query (e.g. "from:boss is:unread newer_than:7d").',
    inputSchema: z.object({
      query: z.string().describe('Gmail search query'),
      max_results: z.number().int().min(1).max(10).optional(),
    }),
    execute: async ({ query, max_results }) => {
      try {
        const list = await call(
          `${GMAIL}/messages?q=${encodeURIComponent(query)}&maxResults=${max_results ?? 5}`,
        );
        const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
        const messages = await Promise.all(
          ids.map(async (id) => {
            const m = await call(
              `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
            );
            const h = m.payload?.headers;
            return { id, from: header(h, 'From'), subject: header(h, 'Subject'), date: header(h, 'Date'), snippet: m.snippet ?? '' };
          }),
        );
        return { messages };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const gmail_read = tool({
    description: "Read the full text of one Gmail message by its id (from gmail_search).",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => {
      try {
        const m = await call(`${GMAIL}/messages/${id}?format=full`);
        const h = m.payload?.headers;
        return {
          from: header(h, 'From'),
          to: header(h, 'To'),
          subject: header(h, 'Subject'),
          date: header(h, 'Date'),
          body: extractBody(m.payload).slice(0, 8000),
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const gmail_send = tool({
    description: 'Send an email from the user\'s Gmail account.',
    inputSchema: z.object({
      to: z.string().describe('Recipient email address'),
      subject: z.string(),
      body: z.string(),
    }),
    execute: async ({ to, subject, body }) => {
      try {
        const mime = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
        const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const res = await call(`${GMAIL}/messages/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }),
        });
        return { ok: true, id: res.id };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const calendar_list = tool({
    description: "List upcoming events from the user's primary Google Calendar.",
    inputSchema: z.object({
      days_ahead: z.number().int().min(1).max(60).optional().describe('Window from now, default 7'),
      max_results: z.number().int().min(1).max(25).optional(),
    }),
    execute: async ({ days_ahead, max_results }) => {
      try {
        const now = new Date();
        const timeMin = now.toISOString();
        const timeMax = new Date(now.getTime() + (days_ahead ?? 7) * 86400000).toISOString();
        const data = await call(
          `${CAL}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=${max_results ?? 10}`,
        );
        const events = (data.items ?? []).map((e: any) => ({
          summary: e.summary ?? '(no title)',
          start: e.start?.dateTime ?? e.start?.date,
          end: e.end?.dateTime ?? e.end?.date,
          location: e.location,
        }));
        return { events };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const calendar_create = tool({
    description: "Create an event on the user's primary Google Calendar. Use ISO 8601 datetimes with timezone offset.",
    inputSchema: z.object({
      summary: z.string(),
      start: z.string().describe('ISO start, e.g. 2026-07-12T15:00:00+03:00'),
      end: z.string().describe('ISO end'),
      description: z.string().optional(),
      location: z.string().optional(),
    }),
    execute: async ({ summary, start, end, description, location }) => {
      try {
        const res = await call(`${CAL}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary,
            description,
            location,
            start: { dateTime: start },
            end: { dateTime: end },
          }),
        });
        return { ok: true, id: res.id, htmlLink: res.htmlLink };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  return { gmail_search, gmail_read, gmail_send, calendar_list, calendar_create };
}
