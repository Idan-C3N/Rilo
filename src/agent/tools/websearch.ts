import { tool } from 'ai';
import { z } from 'zod';

export interface SearchResult {
  title: string;
  url: string;
  content: string;
}

/** Injectable search backend — real impl calls Tavily; tests pass a fake. */
export type SearchFn = (query: string, maxResults: number) => Promise<SearchResult[]>;

/** Default backend: Tavily search API (https://tavily.com). Uses global fetch (Node 22+). */
export function tavilySearch(apiKey: string): SearchFn {
  return async (query, maxResults) => {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: 'basic',
      }),
    });
    if (!res.ok) {
      throw new Error(`Tavily search failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.content ?? '',
    }));
  };
}

/**
 * Bundled default backend: a self-hosted SearXNG instance (https://searxng.github.io).
 * No API key, no signup, no per-query cost. `baseUrl` points at the SearXNG service
 * (e.g. the compose service `http://searxng:8080`). Uses global fetch (Node 22+).
 */
export function searxngSearch(baseUrl: string): SearchFn {
  const base = baseUrl.replace(/\/$/, '');
  return async (query, maxResults) => {
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`SearXNG search failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (data.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: r.content ?? '',
    }));
  };
}

/**
 * Opt-in backend: Google Programmable Search (Custom Search JSON API).
 * `cx` is the Programmable Search Engine id. Google caps `num` at 10.
 * Uses global fetch (Node 22+).
 */
export function googleSearch(apiKey: string, cx: string): SearchFn {
  return async (query, maxResults) => {
    const num = Math.min(maxResults, 10);
    const url =
      `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}` +
      `&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=${num}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Google search failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { items?: Array<{ title?: string; link?: string; snippet?: string }> };
    return (data.items ?? []).map((item) => ({
      title: item.title ?? '',
      url: item.link ?? '',
      content: item.snippet ?? '',
    }));
  };
}

/** Config subset the backend selector needs (structural — satisfied by AppConfig). */
export interface SearchBackendConfig {
  searchBackend?: string;
  searxngUrl?: string;
  googleSearchKey?: string;
  googleSearchCx?: string;
  tavilyApiKey?: string;
}

/**
 * Pick the web-search backend by precedence:
 *   1. If SEARCH_BACKEND is set, use exactly that (fail fast if its config is missing).
 *   2. Else if both Google key + cx are set → Google.
 *   3. Else → SearXNG (the bundled default), when searxngUrl is set.
 * Returns undefined only when nothing usable is configured (no forced backend and
 * no searxngUrl) — in that case the web_search tool is simply not offered.
 * Tavily is never auto-selected; it is reachable only via SEARCH_BACKEND=tavily.
 */
export function selectSearchBackend(cfg: SearchBackendConfig): SearchFn | undefined {
  const forced = cfg.searchBackend;
  if (forced) {
    switch (forced) {
      case 'searxng':
        if (!cfg.searxngUrl) {
          throw new Error('SEARCH_BACKEND=searxng requires SEARXNG_URL to be set.');
        }
        return searxngSearch(cfg.searxngUrl);
      case 'google':
        if (!cfg.googleSearchKey || !cfg.googleSearchCx) {
          throw new Error('SEARCH_BACKEND=google requires both GOOGLE_SEARCH_KEY and GOOGLE_SEARCH_CX to be set.');
        }
        return googleSearch(cfg.googleSearchKey, cfg.googleSearchCx);
      case 'tavily':
        if (!cfg.tavilyApiKey) {
          throw new Error('SEARCH_BACKEND=tavily requires TAVILY_API_KEY to be set.');
        }
        return tavilySearch(cfg.tavilyApiKey);
      default:
        throw new Error(`Unknown SEARCH_BACKEND '${forced}' (expected: searxng | google | tavily).`);
    }
  }
  if (cfg.googleSearchKey && cfg.googleSearchCx) {
    return googleSearch(cfg.googleSearchKey, cfg.googleSearchCx);
  }
  if (cfg.searxngUrl) {
    return searxngSearch(cfg.searxngUrl);
  }
  return undefined;
}

export function makeWebSearchTool(search: SearchFn) {
  return tool({
    description:
      'Search the web for current information — job openings, company career pages, news, facts, anything you do not already know. Returns the top results with title, url, and a content snippet. Use this whenever the user asks about something current or external.',
    inputSchema: z.object({
      query: z.string().describe('The search query'),
      max_results: z.number().int().min(1).max(10).optional().describe('How many results (default 5)'),
    }),
    execute: async ({ query, max_results }) => {
      try {
        const results = await search(query, max_results ?? 5);
        return { results };
      } catch (err) {
        return { error: `web search failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
