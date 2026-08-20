// Fails if a built main/preload bundle requires anything that won't exist in
// the packaged app.
//
// This guards a bug class that is invisible to every other check we run.
// electron-builder.yml ships out/** and package.json only — no node_modules —
// so a bare require("some-dep") left in the bundle crashes the installed app.
// Nothing catches it earlier: lint and tsc look at source, not the bundle, and
// running from a dev checkout resolves the require happily because
// node_modules is right there. It reached a real installer exactly once (a
// require("electron-context-menu") that killed the app at startup), which is
// why this exists.
//
// Legitimate externals are Electron itself and Node builtins, which the
// runtime always provides. Anything else is a packaging bug.
import { builtinModules } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const allowed = new Set([
  'electron',
  // Node omits experimental modules from builtinModules, so node:sqlite is
  // absent from that list despite the runtime providing it — Electron 43's
  // bundled Node has it (the app's FTS5 probe at startup proves it resolves).
  // Listed explicitly rather than loosening the check to any node: prefix,
  // which would wave through a genuine typo.
  'node:sqlite',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

const targets = [
  'out/main/index.js',
  ...readdirSync('out/preload').map((f) => path.join('out/preload', f)),
].filter((f) => f.endsWith('.js'));

let failed = false;

for (const file of targets) {
  const source = readFileSync(file, 'utf8');
  // Bundled output is CJS, so an unbundled dependency shows up as a literal
  // require("name"). Template/computed requires would not match, but
  // electron-vite's externalizer only ever emits literals.
  const found = new Set(
    [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
  );
  const bad = [...found].filter((name) => !allowed.has(name));
  if (bad.length > 0) {
    failed = true;
    console.error(`${file}: not bundled and not available at runtime:`);
    for (const name of bad) console.error(`  - ${name}`);
  }
}

if (failed) {
  console.error(
    '\nSet build.externalizeDeps: false for the affected target in ' +
      'electron.vite.config.ts. electron-vite externalizes every ' +
      'package.json "dependencies" entry by default, ignoring the ' +
      'rollupOptions.external allowlist.',
  );
  process.exit(1);
}

console.log(`Bundle externals OK (${targets.length} files checked).`);
