// Runs scripts/recon-aimode.js against a running app over the Chrome DevTools
// Protocol, instead of asking someone to paste it into a console by hand.
//
//   node scripts/cdp-recon.mjs [--target=127.0.0.1:9222] [--match=google]
//
// Start the app with --devtools-port=9222 (see README). The port is bound to
// loopback, so reaching another machine's app means forwarding it first, e.g.
//   ssh -L 9222:127.0.0.1:9222 user@host
//
// Evaluates in EVERY execution context, not just the main frame. That is the
// point: whether AI Mode renders its history in a subframe is one of the
// unknowns being probed, and a main-frame-only evaluate would report "found
// nothing" for a page that is actually full of content one frame down —
// indistinguishable from the selectors being wrong.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const target = arg('target', '127.0.0.1:9222');
const match = arg('match', 'google');
const base = target.startsWith('http') ? target : `http://${target}`;

const listUrl = `${base}/json/list`;
let targets;
try {
  const res = await fetch(listUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  targets = await res.json();
} catch (err) {
  console.error(`Could not reach ${listUrl}: ${err.message}`);
  console.error('Is the app running with --devtools-port, and is the port forwarded?');
  process.exit(1);
}

const pages = targets.filter((t) => t.type === 'page');
console.error(`Targets (${pages.length} page):`);
for (const t of pages) console.error(`  - ${t.title} :: ${t.url}`);

const chosen = pages.find((t) => (t.url + ' ' + t.title).toLowerCase().includes(match.toLowerCase()));
if (!chosen) {
  console.error(`\nNo page target matched "${match}". Pass --match=<substring> to pick one.`);
  process.exit(1);
}
console.error(`\nUsing: ${chosen.title} :: ${chosen.url}\n`);

const expression = readFileSync(path.join(here, 'recon-aimode.js'), 'utf8');

const ws = new WebSocket(chosen.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const contexts = [];

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Runtime.executionContextCreated') {
    contexts.push(msg.params.context);
    return;
  }
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('WebSocket failed to open')), { once: true });
});

// Runtime.enable replays executionContextCreated for contexts that already
// exist, which is how frames loaded before we connected are discovered.
await send('Runtime.enable');
await new Promise((r) => setTimeout(r, 1500));

const results = [];
for (const ctx of contexts.length > 0 ? contexts : [null]) {
  const params = { expression, returnByValue: true, awaitPromise: false };
  if (ctx) params.contextId = ctx.id;
  const reply = await send('Runtime.evaluate', params);
  const label = ctx ? `${ctx.name || '(unnamed)'} #${ctx.id}` : 'default';
  if (reply.result?.exceptionDetails) {
    results.push({ context: label, error: reply.result.exceptionDetails.text });
    continue;
  }
  const value = reply.result?.result?.value;
  // Contexts that are cross-origin, torn down, or simply about:blank produce
  // nothing useful — kept out of the output so the frames that matter are
  // readable rather than buried.
  if (value && (value.historyControls?.length || value.dataAttributes?.length || value.textBlocks?.length || value.imageHosts?.length)) {
    results.push({ context: label, ...value });
  }
}

ws.close();

if (results.length === 0) {
  console.error('Every context came back empty. The page may still be loading, or the');
  console.error('history panel may not be open. Leave it on screen and re-run.');
  process.exit(2);
}

console.log(JSON.stringify(results, null, 2));
