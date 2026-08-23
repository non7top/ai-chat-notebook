import http from 'node:http';
import net from 'node:net';

/**
 * A Basic-auth proxy in front of Chromium's remote debugging port.
 *
 * Chromium has no authentication on that endpoint and no flag adds one: it is
 * an open door to full control of the embedded panel, which holds a live Google
 * session. Since pull-request builds now open it by default, the door gets a
 * lock — a weak one, deliberately, because a weak lock in the path everything
 * takes is worth more than a strong one nobody applies.
 *
 * What this actually protects. Chromium binds to loopback, so nothing off the
 * machine reaches it either way. The case that matters is a FORWARDED port —
 * ssh -L, Tailscale, a tunnel — which is how this endpoint gets driven from
 * anywhere else, and where "unauthenticated" stops being theoretical. Forward
 * the proxy's port and a password is required.
 *
 * What it does not protect against, stated plainly rather than left to be
 * discovered: any other process on this machine can talk to Chromium's own port
 * directly and skip the proxy entirely. Loopback CDP cannot be hidden from local
 * processes, and this does not pretend to.
 *
 * Basic auth over plain HTTP, so the credentials cross the wire recoverably.
 * Inside a tunnel that is the tunnel's encryption; outside one it would not be
 * safe, which is the same condition the endpoint itself has.
 */
export interface CdpProxyOptions {
  /** Port clients connect to. This is the one to forward. */
  publicPort: number;
  /** Port Chromium was told to listen on. Never forward this one. */
  internalPort: number;
  user: string;
  password: string;
}

function unauthorized(response: http.ServerResponse): void {
  response.writeHead(401, {
    // Chromium's own tooling ignores this, but curl and every CDP client
    // library use it to know a password is wanted rather than guessing.
    'WWW-Authenticate': 'Basic realm="AI Chat Notebook CDP"',
    'Content-Type': 'text/plain',
  });
  response.end('Authentication required.\n');
}

function authorised(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const given = Buffer.from(header.slice('Basic '.length), 'base64');
  const want = Buffer.from(expected);
  // Length-independent compare: timingSafeEqual throws on a length mismatch,
  // which would itself leak the length through an exception.
  if (given.length !== want.length) return false;
  let same = 0;
  for (let i = 0; i < given.length; i += 1) same |= given[i] ^ want[i];
  return same === 0;
}

export function startCdpProxy(options: CdpProxyOptions): http.Server {
  const { publicPort, internalPort, user, password } = options;
  const expected = `${user}:${password}`;

  const server = http.createServer((request, response) => {
    if (!authorised(request.headers.authorization, expected)) {
      unauthorized(response);
      return;
    }

    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: internalPort,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: `127.0.0.1:${internalPort}` },
      },
      (upstreamResponse) => {
        const type = upstreamResponse.headers['content-type'] ?? '';
        if (!type.includes('application/json')) {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
          return;
        }
        // The target list hands out WebSocket URLs containing the port
        // Chromium listens on. Passed through unchanged, every client would
        // reconnect straight to Chromium and bypass this proxy — the endpoint
        // would look protected while being wide open through its own directory.
        const chunks: Buffer[] = [];
        upstreamResponse.on('data', (chunk) => chunks.push(chunk));
        upstreamResponse.on('end', () => {
          const rewritten = Buffer.concat(chunks)
            .toString('utf8')
            .split(`127.0.0.1:${internalPort}`)
            .join(`127.0.0.1:${publicPort}`)
            .split(`localhost:${internalPort}`)
            .join(`127.0.0.1:${publicPort}`);
          const headers = { ...upstreamResponse.headers };
          // The body was buffered and rewritten, so it is now a single known
          // length. Both of the upstream's framing headers have to go before
          // the new one is set: a stale content-length truncates the JSON or
          // hangs the client, and a surviving transfer-encoding alongside a
          // content-length is an illegal combination that Node rejects outright
          // with HPE_INVALID_CONTENT_LENGTH. Chromium answers /json chunked, so
          // this is the ordinary path and not an edge case.
          delete headers['content-length'];
          delete headers['transfer-encoding'];
          headers['content-length'] = String(Buffer.byteLength(rewritten));
          response.writeHead(upstreamResponse.statusCode ?? 200, headers);
          response.end(rewritten);
        });
      },
    );
    upstream.on('error', () => {
      response.writeHead(502, { 'Content-Type': 'text/plain' });
      response.end('Remote debugging endpoint unreachable.\n');
    });
    request.pipe(upstream);
  });

  // CDP is a WebSocket protocol, so the upgrade is the part that carries every
  // command. Authenticated the same way and then piped raw — no framing to
  // understand, both ends speak the same protocol to each other.
  server.on('upgrade', (request, socket, head) => {
    if (!authorised(request.headers.authorization, expected)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="CDP"\r\n\r\n');
      return;
    }
    const upstream = net.connect(internalPort, '127.0.0.1', () => {
      const lines = [`GET ${request.url} HTTP/1.1`];
      for (const [name, value] of Object.entries(request.headers)) {
        // Not forwarded: it is this proxy's credential, not Chromium's, and
        // Chromium has no notion of one.
        if (name === 'authorization') continue;
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    // Both directions are torn down together: half-closed CDP sockets leave a
    // client waiting for a reply that can never arrive.
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  server.listen(publicPort, '127.0.0.1');
  return server;
}
