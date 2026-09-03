/**
 * Refuses to release a bundle built with debug defaults.
 *
 * Pull-request builds set NOTEBOOK_DEBUG_BUILD=1, which bakes an on-by-default
 * unauthenticated CDP port into the main bundle. A release must not have it, and
 * "the release workflow does not set that variable" is a property of a YAML file
 * rather than of the artifact — one copied step, one inherited environment, and
 * a release ships listening on 9222 with no sign of it except a window title.
 *
 * So the artifact is asked directly.
 *
 *   node scripts/check-not-debug.mjs
 */
import fs from 'node:fs';

const bundle = 'out/main/index.js';
if (!fs.existsSync(bundle)) {
  console.error(`${bundle} not found — run npm run build first.`);
  process.exit(1);
}

const source = fs.readFileSync(bundle, 'utf8');

// The define is replaced with a literal at build time, so the debug branch is
// either present in the emitted code or eliminated from it. Matching on the
// marker text is what makes this readable in a failure: it names the thing that
// would be wrong rather than a boolean somewhere.
const marker = 'DEBUG BUILD (remote debugging on)';
if (source.includes(marker)) {
  console.error(
    `${bundle} was built with NOTEBOOK_DEBUG_BUILD=1: it enables an ` +
      'unauthenticated remote debugging port by default. Rebuild without it.',
  );
  process.exit(1);
}

console.log('Bundle is not a debug build.');
