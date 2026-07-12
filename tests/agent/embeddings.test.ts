import { describe, it, expect } from 'vitest';
import { makeEmbedder, embedQuery, embedPassages, type Embedder } from '../../src/agent/embeddings.js';

describe('makeEmbedder', () => {
  it('POSTs inputs to {baseUrl}/embed and returns the matrix', async () => {
    let seen: any;
    const fake = (async (url: string, init: any) => {
      seen = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => [[1, 2, 3]] } as any;
    }) as unknown as typeof fetch;
    const embed = makeEmbedder('http://embed:80/', fake);
    const out = await embed(['x']);
    expect(seen.url).toBe('http://embed:80/embed'); // trailing slash normalized
    expect(seen.body).toEqual({ inputs: ['x'] });
    expect(out).toEqual([[1, 2, 3]]);
  });

  it('returns null on non-OK', async () => {
    const fake = (async () => ({ ok: false, status: 500, text: async () => 'err' }) as any) as unknown as typeof fetch;
    expect(await makeEmbedder('http://e', fake)(['x'])).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fake = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await makeEmbedder('http://e', fake)(['x'])).toBeNull();
  });
});

describe('prefixing helpers', () => {
  it('embedQuery prefixes "query: " and returns a Float32Array', async () => {
    let seen: string[] = [];
    const embed: Embedder = async (inputs) => { seen = inputs; return [[0.1, 0.2]]; };
    const v = await embedQuery(embed, 'hi');
    expect(seen).toEqual(['query: hi']);
    expect(v).toBeInstanceOf(Float32Array);
    expect(Array.from(v!)).toEqual([Math.fround(0.1), Math.fround(0.2)]);
  });

  it('embedPassages prefixes "passage: " per input', async () => {
    let seen: string[] = [];
    const embed: Embedder = async (inputs) => { seen = inputs; return inputs.map(() => [1]); };
    const vs = await embedPassages(embed, ['a', 'b']);
    expect(seen).toEqual(['passage: a', 'passage: b']);
    expect(vs.every((v) => v instanceof Float32Array)).toBe(true);
  });

  it('embedPassages returns all-null when embedder returns null', async () => {
    const embed: Embedder = async () => null;
    expect(await embedPassages(embed, ['a', 'b'])).toEqual([null, null]);
  });
});
