/**
 * Postinstall fix: the published @runanywhere/* android build.gradle files only
 * map macOS/Linux hosts to NDK prebuilt dirs, so Android builds fail on a
 * Windows dev machine ("Unsupported host for Android NDK runtime lookup").
 * Adds the windows-x86_64 host tag. Idempotent. Remove once the fix ships
 * upstream (patched in the runanywhere-sdks monorepo on this machine already).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OLD = `    if (osName.contains("linux")) return "linux-x86_64"
    throw new GradleException("Unsupported host for Android NDK runtime lookup:`;
const NEW = `    if (osName.contains("linux")) return "linux-x86_64"
    if (osName.contains("windows")) return "windows-x86_64"
    throw new GradleException("Unsupported host for Android NDK runtime lookup:`;

for (const pkg of ['core', 'llamacpp', 'onnx', 'qhexrt']) {
  const file = join(root, 'node_modules', '@runanywhere', pkg, 'android', 'build.gradle');
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf8');
  if (src.includes('windows-x86_64')) {
    console.log(`[fix-runanywhere-windows] ${pkg}: already patched`);
  } else if (src.includes(OLD)) {
    writeFileSync(file, src.replace(OLD, NEW));
    console.log(`[fix-runanywhere-windows] ${pkg}: patched`);
  } else {
    console.warn(`[fix-runanywhere-windows] ${pkg}: pattern not found — check upstream fix`);
  }
}

// -----------------------------------------------------------------------------
// Second fix: the RN binding refuses LoadOptions.contextLength even though the
// ModelLoadRequest proto carries it (field: "the one load knob every on-device
// runtime exposes"). Without it every model loads with a 2048 context and the
// agent's multi-turn transcripts overflow. Patched in the SDK monorepo too.
// -----------------------------------------------------------------------------
const loadSupport = join(
  root,
  'node_modules/@runanywhere/core/src/Public/Api/LoadOptionsSupport.ts',
);
if (existsSync(loadSupport)) {
  const src = readFileSync(loadSupport, 'utf8');
  const gate = "    options?.contextLength !== undefined ? 'contextLength' : undefined,\n";
  if (src.includes(gate)) {
    writeFileSync(loadSupport, src.replace(gate, ''));
    console.log('[fix-runanywhere-windows] core: contextLength gate removed');
  } else {
    console.log('[fix-runanywhere-windows] core: contextLength gate already removed');
  }
}
const modelsTs = join(root, 'node_modules/@runanywhere/core/src/Public/Api/Models.ts');
if (existsSync(modelsTs)) {
  const src = readFileSync(modelsTs, 'utf8');
  const anchor = `        ...(requestedBackend ? { framework: requestedBackend.backend } : {}),
        forceReload: options?.forceReload ?? false,`;
  const patched = `        ...(requestedBackend ? { framework: requestedBackend.backend } : {}),
        ...(options?.contextLength !== undefined ? { contextLength: options.contextLength } : {}),
        forceReload: options?.forceReload ?? false,`;
  if (src.includes(patched)) {
    console.log('[fix-runanywhere-windows] core: contextLength already forwarded');
  } else if (src.includes(anchor)) {
    writeFileSync(modelsTs, src.replace(anchor, patched));
    console.log('[fix-runanywhere-windows] core: contextLength forwarded in load()');
  } else {
    console.warn('[fix-runanywhere-windows] core: Models.ts anchor not found');
  }
}
