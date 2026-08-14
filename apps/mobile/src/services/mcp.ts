import type { JsonSchema } from '@minimus/agent-core';
import type { McpServerConfig } from '../stores/toolStore';
import { diag } from './diag';

/**
 * Minimal MCP client over streamable HTTP: initialize → tools/list →
 * tools/call, JSON-RPC 2.0. Good enough to bridge hosted MCP servers
 * (Slack, GDrive, custom) into the agent's tool registry.
 *
 * RN's fetch buffers whole bodies (no ReadableStream), so servers that
 * answer in SSE framing are handled by parsing the buffered `data:` lines —
 * fine for request/response; server-initiated streams are out of scope.
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * The auth field accepts two forms:
 *   "Bearer abc123"          → Authorization: Bearer abc123
 *   "x-api-key: abc123"      → x-api-key: abc123   (Composio-style)
 * A colon BEFORE the first space marks the header-name form.
 */
export function authHeader(auth: string): [string, string] | null {
  const trimmed = auth.trim();
  if (!trimmed) return null;
  const colon = trimmed.indexOf(':');
  const space = trimmed.indexOf(' ');
  if (colon > 0 && (space === -1 || colon < space)) {
    return [trimmed.slice(0, colon).trim(), trimmed.slice(colon + 1).trim()];
  }
  return ['authorization', trimmed];
}

function parseBody(text: string, contentType: string): JsonRpcResponse {
  if (contentType.includes('text/event-stream')) {
    // Last data: line wins — request/response servers send exactly one.
    let last: JsonRpcResponse | undefined;
    for (const line of text.split('\n')) {
      const m = /^data:\s*(.+)$/.exec(line.trim());
      if (m) {
        try {
          last = JSON.parse(m[1]!) as JsonRpcResponse;
        } catch {
          /* keep scanning */
        }
      }
    }
    if (!last) throw new Error('no JSON payload in SSE response');
    return last;
  }
  return JSON.parse(text) as JsonRpcResponse;
}

export class McpClient {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(private config: McpServerConfig) {}

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const auth = authHeader(this.config.auth);
    if (auth) headers[auth[0]] = auth[1];
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const res = await fetch(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
    });
    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`MCP ${this.config.name} ${method}: HTTP ${res.status} ${detail.slice(0, 160)}`);
    }
    const parsed = parseBody(await res.text(), res.headers.get('content-type') ?? '');
    if (parsed.error) {
      throw new Error(`MCP ${this.config.name} ${method}: ${parsed.error.message}`);
    }
    return parsed.result;
  }

  private async notify(method: string): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const auth = authHeader(this.config.auth);
    if (auth) headers[auth[0]] = auth[1];
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    await fetch(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method }),
    }).catch(() => undefined);
  }

  async connect(): Promise<McpTool[]> {
    await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'runanywhere-agent', version: '1.0' },
    });
    await this.notify('notifications/initialized');
    const result = (await this.rpc('tools/list', {})) as { tools?: McpTool[] };
    const tools = result.tools ?? [];
    diag(`mcp ${this.config.name}: connected, ${tools.length} tools`);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.rpc('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`))
      .join('\n');
    if (result.isError) throw new Error(text || 'MCP tool reported an error');
    return text || 'ok';
  }
}
