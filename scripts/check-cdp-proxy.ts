/**
 * The Basic-auth proxy in front of Chromium's remote debugging port.
 *
 * Chromium has no authentication on that endpoint, so this proxy is the whole
 * of it — and a lock that does not actually lock is worse than none, because it
 * invites forwarding a port believing it is protected. Every claim made about it
 * is therefore checked against a real socket rather than reasoned about.
 *
 * A stand-in upstream stands for Chromium: the proxy has no idea what is behind
 * it, so a plain HTTP server that answers /json the way Chromium does exercises
 * exactly the same paths.
 *
 *   npm run check:cdp-proxy
 */
import http from 'node:http';
import net from 'node:net';
import { startCdpProxy } from '../src/main/cdpProxy.ts';

const INTERNAL = 39223;
const PUBLIC = 39222;
const AUTH = `Basic ${Buffer.from('ai:ai').toString('base64')}`;

let failures = 0;
function check(what: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`, ok ? '' : `got ${JSON.stringify(got)}`);
}

// Answers like Chromium: a target list whose WebSocket URL names its own port.
const upstream = http.createServer((request, response) => {
  if (request.url === '/json/list') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify([
        {
          id: 'PAGE1',
          webSocketDebuggerUrl: `ws://127.0.0.1:${INTERNAL}/devtools/page/PAGE1`,
          devtoolsFrontendUrl: `/devtools/inspector.html?ws=127.0.0.1:${INTERNAL}/devtools/page/PAGE1`,
        },
      ]),
    );
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/plain' });
  response.end('plain');
});
// A CDP client's first move is the WebSocket upgrade, which is where every
// command travels — authenticating only the HTTP side would protect the
// directory and leave the protocol open.
upstream.on('upgrade', (_request, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
  socket.write('UPSTREAM-SPEAKING');
});

const get = (path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: PUBLIC, path, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });

const upgrade = (headers: Record<string, string>) =>
  new Promise<string>((resolve) => {
    const socket = net.connect(PUBLIC, '127.0.0.1', () => {
      const lines = [
        'GET /devtools/page/PAGE1 HTTP/1.1',
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    let seen = '';
    socket.on('data', (chunk) => {
      seen += chunk.toString('utf8');
      if (seen.includes('UPSTREAM-SPEAKING') || seen.includes('401')) {
        socket.destroy();
        resolve(seen);
      }
    });
    socket.on('close', () => resolve(seen));
    socket.on('error', () => resolve(seen));
  });

await new Promise<void>((done) => upstream.listen(INTERNAL, '127.0.0.1', done));
const proxy = startCdpProxy({
  publicPort: PUBLIC,
  internalPort: INTERNAL,
  user: 'ai',
  password: 'ai',
});
await new Promise<void>((done) => proxy.once('listening', done));

const noAuth = await get('/json/list');
check('no credentials is refused', noAuth.status, 401);
check('refusal says a password is wanted', noAuth.body.includes('Authentication'), true);

const wrong = await get('/json/list', { authorization: `Basic ${Buffer.from('ai:no').toString('base64')}` });
check('wrong password is refused', wrong.status, 401);

// A shorter credential must not pass by being a prefix of the right one.
const short = await get('/json/list', { authorization: `Basic ${Buffer.from('a').toString('base64')}` });
check('a prefix of the credential is refused', short.status, 401);

const ok = await get('/json/list', { authorization: AUTH });
check('correct password is let through', ok.status, 200);

// The rewrite is the load-bearing part: passed through unchanged, a client
// would read Chromium's own port out of the target list and reconnect straight
// to it, bypassing this proxy entirely — protected in appearance only.
check('target list points at the proxy, not Chromium', ok.body.includes(`127.0.0.1:${PUBLIC}`), true);
check('target list never names the internal port', ok.body.includes(String(INTERNAL)), false);

// A truncated body is the symptom of a stale content-length after rewriting.
check('rewritten body parses whole', JSON.parse(ok.body)[0].id, 'PAGE1');

const upNoAuth = await upgrade({});
check('websocket upgrade without credentials is refused', upNoAuth.includes('401'), true);
check('websocket upgrade without credentials reaches nothing', upNoAuth.includes('UPSTREAM'), false);

const upAuth = await upgrade({ authorization: AUTH });
check('websocket upgrade with credentials reaches upstream', upAuth.includes('UPSTREAM-SPEAKING'), true);

proxy.close();
upstream.close();
if (failures > 0) throw new Error(`${failures} check(s) failed`);
console.log('OK');
// Exits explicitly: the proxied sockets from the upgrade tests keep the event
// loop alive after both servers are closed, so without this the checks all pass
// and the process simply never returns — which in CI is a hung job, not a
// failure anyone can read.
process.exit(0);
