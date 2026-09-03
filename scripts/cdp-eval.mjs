// Evaluates an expression in a running app's page over CDP, for iterating on
// selectors against the real thing.
//
//   docker compose run --rm recon node scripts/cdp-eval.mjs --file=/tmp/q.js
//   docker compose run --rm recon node scripts/cdp-eval.mjs 'document.title'
//
// Options: --target=127.0.0.1:9222  --match=google  --file=<path>  --auth=user:pass
//
// --auth is needed against a debug build, whose debugging port sits behind a
// Basic-auth proxy (default ai:ai — see src/main/cdpProxy.ts). The credentials
// go into the WebSocket URL's userinfo rather than a header, because the global
// WebSocket takes no headers; the runtime turns userinfo into the Authorization
// header the proxy is looking for.
//
// Evaluates in the matched target's default context (main frame, main world).
// Read-only by convention: this drives a live logged-in session, so anything
// that clicks or navigates belongs in a deliberate, separately-reviewed step,
// not in an exploratory query.
import { readFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const target = arg('target', '127.0.0.1:9222');
const match = arg('match', 'google');
const file = arg('file', null);
const auth = arg('auth', process.env.NOTEBOOK_DEVTOOLS_AUTH ?? null);
const base = target.startsWith('http') ? target : `http://${target}`;

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const expression = file ? readFileSync(file, 'utf8') : positional[0];
if (!expression) {
  console.error('Nothing to evaluate. Pass an expression or --file=<path>.');
  process.exit(1);
}

const headers = auth
  ? { authorization: `Basic ${Buffer.from(auth).toString('base64')}` }
  : undefined;
const res = await fetch(`${base}/json/list`, { headers });
if (!res.ok) {
  console.error(
    `${base}/json/list returned ${res.status}` +
      (res.status === 401 ? ' — pass --auth=user:pass (a debug build defaults to ai:ai).' : ''),
  );
  process.exit(1);
}
const pages = (await res.json()).filter((t) => t.type === 'page');
const chosen = pages.find((t) => (t.url + ' ' + t.title).toLowerCase().includes(match.toLowerCase()));
if (!chosen) {
  console.error(`No page target matched "${match}". Available:`);
  for (const t of pages) console.error(`  - ${t.title} :: ${t.url}`);
  process.exit(1);
}

// Used as handed back. Against a debug build the proxy has already put the
// credential in this URL: the WebSocket API takes no headers and the URL spec
// forbids userinfo on ws://, so there is no other way for this client to
// authenticate the upgrade.
const ws = new WebSocket(chosen.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
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

const reply = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true,
});
ws.close();

if (reply.result?.exceptionDetails) {
  console.error('Threw:', reply.result.exceptionDetails.text);
  console.error(JSON.stringify(reply.result.exceptionDetails.exception, null, 2));
  process.exit(1);
}
const value = reply.result?.result?.value;
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
