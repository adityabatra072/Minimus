import type { ToolRegistry } from '@minimus/agent-core';
import { useToolStore, type CustomHttpTool } from '../stores/toolStore';
import { McpClient, type McpTool } from './mcp';
import { diag } from './diag';

/**
 * Turns toolStore state into live registry entries:
 * - custom HTTP tools → group 'custom' (name prefixed nothing; user owns it)
 * - MCP server tools → group 'mcp', named mcp_<server>_<tool>
 *
 * All user-added tools require approval by default: they reach the network
 * with agent-chosen arguments, and the approval card is the honest boundary.
 * Built-in disabling is enforced at run time via excludeTools (userExcludedTools).
 */

const registered = new Set<string>();
const mcpClients = new Map<string, McpClient>();
/** Connection status per MCP server for the Tools screen. */
export const mcpStatus = new Map<string, { state: 'ok' | 'error'; detail: string; tools: number }>();

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
}

function customParamSchema(spec: string) {
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];
  for (const part of spec.split(',')) {
    const [name, ...desc] = part.split(':');
    const key = sanitize(name?.trim() ?? '');
    if (!key) continue;
    properties[key] = { type: 'string', ...(desc.length ? { description: desc.join(':').trim() } : {}) };
    required.push(key);
  }
  return { type: 'object' as const, properties, required };
}

function registerCustom(registry: ToolRegistry, tool: CustomHttpTool) {
  const name = sanitize(tool.name);
  if (!name || registered.has(name)) return;
  let headers: Record<string, string> = {};
  try {
    headers = tool.headersJson.trim() ? (JSON.parse(tool.headersJson) as Record<string, string>) : {};
  } catch {
    headers = {};
  }
  registry.register({
    name,
    group: 'custom',
    description: tool.description,
    parameters: customParamSchema(tool.params),
    needsApproval: true,
    execute: async (args, ctx) => {
      let url = tool.url;
      const init: RequestInit = { method: tool.method, headers: { ...headers }, signal: ctx.signal };
      if (tool.method === 'GET') {
        const qs = Object.entries(args)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&');
        if (qs) url += (url.includes('?') ? '&' : '?') + qs;
      } else {
        (init.headers as Record<string, string>)['content-type'] = 'application/json';
        init.body = JSON.stringify(args);
      }
      const res = await fetch(url, init);
      const text = await res.text();
      if (!res.ok) return { error: `HTTP ${res.status}`, body: text.slice(0, 500) };
      return { status: res.status, body: text.slice(0, 2000) };
    },
  });
  registered.add(name);
}

function registerMcpTool(registry: ToolRegistry, server: string, client: McpClient, tool: McpTool) {
  const name = sanitize(`mcp_${server}_${tool.name}`);
  if (!name || registered.has(name)) return;
  registry.register({
    name,
    group: 'mcp',
    description: `[${server}] ${tool.description}`.slice(0, 200),
    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    needsApproval: true,
    execute: async (args) => client.callTool(tool.name, args),
  });
  registered.add(name);
}

/**
 * Reconcile the registry with the current store state. Cheap to call again:
 * removed entries are unregistered, new ones registered, MCP servers
 * (re)connected only when not yet known.
 */
export async function syncToolPlatform(registry: ToolRegistry): Promise<void> {
  const { custom, mcpServers } = useToolStore.getState();

  // Drop registrations whose source is gone.
  const wantedCustom = new Set(custom.map((t) => sanitize(t.name)));
  const liveServers = new Set(mcpServers.map((s) => sanitize(s.name)));
  for (const name of [...registered]) {
    const isMcp = name.startsWith('mcp_');
    const keep = isMcp
      ? [...liveServers].some((s) => name.startsWith(`mcp_${s}_`))
      : wantedCustom.has(name);
    if (!keep) {
      registry.unregister(name);
      registered.delete(name);
    }
  }
  for (const server of [...mcpClients.keys()]) {
    if (!liveServers.has(sanitize(server))) {
      mcpClients.delete(server);
      mcpStatus.delete(server);
    }
  }

  for (const tool of custom) registerCustom(registry, tool);

  await Promise.all(
    mcpServers.map(async (server) => {
      if (mcpClients.has(server.name)) return;
      const client = new McpClient(server);
      try {
        const tools = await client.connect();
        mcpClients.set(server.name, client);
        for (const tool of tools) registerMcpTool(registry, sanitize(server.name), client, tool);
        mcpStatus.set(server.name, { state: 'ok', detail: 'connected', tools: tools.length });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        mcpStatus.set(server.name, { state: 'error', detail, tools: 0 });
        diag(`mcp ${server.name}: ${detail}`);
      }
    }),
  );
}

/** Extra tool groups active right now (only when they'd expose something). */
export function userToolGroups(): string[] {
  const { custom, mcpServers } = useToolStore.getState();
  return [...(custom.length ? ['custom'] : []), ...(mcpServers.length ? ['mcp'] : [])];
}

/** Built-ins the user switched off — merged into every run's excludeTools. */
export function userExcludedTools(): string[] {
  return useToolStore.getState().disabled;
}
