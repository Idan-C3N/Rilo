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
