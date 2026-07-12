// Transport + e5 prefixing for a HuggingFace Text-Embeddings-Inference server.
// Enhancement-only: every failure path resolves to null and never throws.

export type Embedder = (inputs: string[]) => Promise<number[][] | null>;

/** Build an Embedder that POSTs to a TEI server's /embed endpoint. */
export function makeEmbedder(baseUrl: string, fetchImpl: typeof fetch = fetch): Embedder {
  const base = baseUrl.replace(/\/+$/, '');
  return async (inputs) => {
    try {
      const res = await fetchImpl(`${base}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs }),
      });
      if (!res.ok) return null;
      return (await res.json()) as number[][];
    } catch {
      return null;
    }
  };
}

const toVec = (row: number[] | undefined): Float32Array | null =>
  row ? Float32Array.from(row) : null;

/** Embed one query string (e5 "query: " prefix). */
export async function embedQuery(embed: Embedder, text: string): Promise<Float32Array | null> {
  const out = await embed([`query: ${text}`]);
  return out ? toVec(out[0]) : null;
}

/** Embed passages (e5 "passage: " prefix); result aligns 1:1 with inputs. */
export async function embedPassages(embed: Embedder, texts: string[]): Promise<(Float32Array | null)[]> {
  const out = await embed(texts.map((t) => `passage: ${t}`));
  if (!out) return texts.map(() => null);
  return texts.map((_, i) => toVec(out[i]));
}
