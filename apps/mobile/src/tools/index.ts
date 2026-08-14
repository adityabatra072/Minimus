import { NativeModules } from 'react-native';
import { ToolRegistry } from '@minimus/agent-core';
import { deviceTools } from './deviceTools';
import { webTools } from './webTools';
import { scheduleTools } from './scheduleTools';
import { commsTools } from './commsTools';
import { musicTools } from './musicTools';
import { memoryTools } from './memoryTools';
import { bindMacroRegistry, macroTools } from './macroTools';
import { visionTools } from './visionTools';

/**
 * Build the live tool registry for this device. Only WORKING tools get
 * registered — a tool that always errors teaches the model (and the demo
 * audience) that the agent is broken. As native modules land, their tools
 * join here.
 */
let shared: ToolRegistry | null = null;

/**
 * The one registry for the whole app. Screens must not build their own:
 * macros bind to a registry to execute their steps, so a second instance
 * would leave taught verbs running against a different tool set.
 */
export function getToolRegistry(): ToolRegistry {
  if (!shared) shared = buildToolRegistry();
  return shared;
}

export function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const hasNativeTools = Boolean((NativeModules as Record<string, unknown>)['MinimusTools']);
  for (const tool of [
    ...deviceTools(),
    ...webTools(),
    ...commsTools(),
    ...musicTools(),
    ...memoryTools(),
    ...macroTools(),
    ...visionTools(),
    ...(hasNativeTools ? scheduleTools() : []),
  ]) {
    registry.register(tool);
  }
  // Macros execute other tools, so they need the finished registry.
  bindMacroRegistry(() => registry);
  return registry;
}
