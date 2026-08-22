// Captures a PNG of a running app target over CDP.
//
//   docker compose run --rm recon node scripts/cdp-screenshot.mjs --match=notebook --out=.shots/app.png
//
// Note the embedded panel will NOT appear: a WebContentsView is a separate
// native compositor layer, so a screenshot of the app's own renderer shows the
// app UI with a blank gap where the panel sits. That is the intended subject
// here — capture the panel by pointing --match at the Google target instead.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const target = arg('target', '127.0.0.1:9222');
const match = arg('match', 'notebook');
const out = arg('out', '.shots/screenshot.png');
const base = target.startsWith('http') ? target : `http://${target}`;

const pages = (await (await fetch(`${base}/json/list`)).json()).filter((t) => t.type === 'page');
const chosen = pages.find((t) => (t.url + ' ' + t.title).toLowerCase().includes(match.toLowerCase()));
if (!chosen) {
  console.error(`No page target matched "${match}". Available:`);
  for (const t of pages) console.error(`  - ${t.title} :: ${t.url}`);
  process.exit(1);
}

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

const reply = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
ws.close();

if (!reply.result?.data) {
  console.error('Capture failed:', JSON.stringify(reply).slice(0, 400));
  process.exit(1);
}

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(reply.result.data, 'base64'));
console.log(`Wrote ${out} (${chosen.title})`);
