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
