import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * User-controlled tool surface: which built-ins are disabled, which custom
 * HTTP tools exist, which MCP servers are connected. Persisted; the registry
 * sync in services/toolPlatform.ts turns this state into live tools.
 */

export interface CustomHttpTool {
  /** snake_case tool name the model will call. */
  name: string;
  description: string;
  method: 'GET' | 'POST';
  url: string;
  /** JSON object of extra headers (auth etc.). */
  headersJson: string;
  /**
   * Simple parameter spec: comma-separated "name:description" pairs. Every
   * parameter is a string; GET appends query params, POST sends JSON body.
   */
  params: string;
}

export interface McpServerConfig {
  /** Short label; also namespaces the bridged tool names. */
  name: string;
  url: string;
  /** Optional Authorization header value (e.g. "Bearer …"). */
  auth: string;
}

interface ToolState {
  disabled: string[];
  custom: CustomHttpTool[];
  mcpServers: McpServerConfig[];
  hydrate: () => Promise<void>;
  setDisabled: (name: string, off: boolean) => void;
  addCustom: (tool: CustomHttpTool) => void;
  removeCustom: (name: string) => void;
  addMcpServer: (server: McpServerConfig) => void;
  removeMcpServer: (name: string) => void;
}

const KEY = 'minimus.tools.v1';

function persist(state: Pick<ToolState, 'disabled' | 'custom' | 'mcpServers'>) {
  AsyncStorage.setItem(
    KEY,
    JSON.stringify({ disabled: state.disabled, custom: state.custom, mcpServers: state.mcpServers }),
  ).catch(() => undefined);
}

export const useToolStore = create<ToolState>((set, get) => ({
  disabled: [],
  custom: [],
  mcpServers: [],

  hydrate: async () => {
    const raw = await AsyncStorage.getItem(KEY).catch(() => null);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as Partial<Pick<ToolState, 'disabled' | 'custom' | 'mcpServers'>>;
      set({
        disabled: saved.disabled ?? [],
        custom: saved.custom ?? [],
        mcpServers: saved.mcpServers ?? [],
      });
    } catch {
      /* corrupt — keep defaults */
    }
  },

  setDisabled: (name, off) => {
    const disabled = off
      ? [...new Set([...get().disabled, name])]
      : get().disabled.filter((n) => n !== name);
    set({ disabled });
    persist({ ...get(), disabled });
  },

  addCustom: (tool) => {
    const custom = [...get().custom.filter((t) => t.name !== tool.name), tool];
    set({ custom });
    persist({ ...get(), custom });
  },

  removeCustom: (name) => {
    const custom = get().custom.filter((t) => t.name !== name);
    set({ custom });
    persist({ ...get(), custom });
  },

  addMcpServer: (server) => {
    const mcpServers = [...get().mcpServers.filter((s) => s.name !== server.name), server];
    set({ mcpServers });
    persist({ ...get(), mcpServers });
  },

  removeMcpServer: (name) => {
    const mcpServers = get().mcpServers.filter((s) => s.name !== name);
    set({ mcpServers });
    persist({ ...get(), mcpServers });
  },
}));
