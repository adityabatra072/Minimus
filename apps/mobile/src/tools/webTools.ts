import type { ToolDefinition } from '@minimus/agent-core';

/**
 * Web tools implemented in pure TS (no native code): DuckDuckGo Lite HTML
 * search (same approach as the SDK's built-in web-search tool) + readable
 * page fetch. Schemas MUST stay in lockstep with packages/eval/src/mockTools.ts.
 */

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x?\d+;/g, ' ');
}

export async function ddgLiteSearch(query: string, signal: AbortSignal) {
  const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone; like Mac OS X) minimus/0.1' },
    signal,
  });
  if (!res.ok) throw new Error(`search failed: HTTP ${res.status}`);
  const html = await res.text();
  const results: { title: string; url: string; snippet: string }[] = [];
  // DDG Lite rows: <a rel="nofollow" href="//duckduckgo.com/l/?uddg=<ENCODED>&rut=…"
  // class='result-link'>TITLE</a> — the real URL hides in the uddg param.
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*class='result-link'[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<td class="result-snippet">([\s\S]*?)<\/td>/g;
  const links: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < 6) {
    let url = decodeEntities(m[1]!);
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) {
      try {
        url = decodeURIComponent(uddg[1]!);
      } catch {
        /* keep redirect url */
      }
    } else if (url.startsWith('//')) {
      url = 'https:' + url;
    }
    if (url.startsWith('http')) {
      links.push({ url, title: decodeEntities(m[2]!.replace(/<[^>]+>/g, '')).trim() });
    }
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < 6) {
    snippets.push(decodeEntities(m[1]!.replace(/<[^>]+>/g, '')).trim());
  }
  for (let i = 0; i < links.length; i++) {
    results.push({
      ...links[i]!,
      snippet: (snippets[i] ?? '').slice(0, 220),
    });
  }
  // Three tight results beat five sprawling ones: a 2.6B model has to REASON
  // over whatever we inject, and long snippet walls eat its output budget.
  return { results: results.slice(0, 3) };
}

export function webTools(): ToolDefinition[] {
  return [
    {
      name: 'web_search',
      group: 'web',
      description: 'Search the web and get result titles, URLs and snippets',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'search query' } },
        required: ['query'],
      },
      execute: async (args, ctx) => ddgLiteSearch(String(args['query']), ctx.signal),
    },
    {
      name: 'fetch_page',
      group: 'web',
      description: 'Fetch a web page and return its readable text',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      execute: async (args, ctx) => {
        const res = await fetch(String(args['url']), { signal: ctx.signal });
        if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
        const html = await res.text();
        const text = decodeEntities(
          html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' '),
        ).trim();
        return { text: text.slice(0, 6000) };
      },
    },
  ];
}
