// LAN HTTPS app proxy carries WebSocket upgrades intact: the app's own 101
// (Sec-WebSocket-Accept, subprotocol) reaches the browser, bytes sent with the
// handshake are not lost, and a refusal is passed back instead of hanging.
// A hand-written 101 without Sec-WebSocket-Accept broke Open WebUI over https.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureTlsCerts, LanHttpsServers, tlsKeyPair } from '../../src/system/lan-https.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const accept = (key: string) => createHash('sha1').update(key + GUID).digest('base64');

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function upgrade(port: number, pathname: string, extra: Record<string, string> = {}): Promise<{ res: IncomingMessage; socket?: Socket; head?: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: '127.0.0.1', port, path: pathname, rejectUnauthorized: false, agent: false,
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', host: 'harbor.local:' + port, ...extra },
    });
    req.on('upgrade', (res, socket, head) => resolve({ res, socket: socket as Socket, head }));
    req.on('response', (res) => resolve({ res }));
    req.on('error', reject);
    req.end();
  });
}

describe('LAN HTTPS app proxy: WebSocket upgrades', () => {
  const ok = hasOpenssl();
  let dir = '';
  let app: Server;
  let servers: LanHttpsServers;
  let securePort = 0;
  let seen: IncomingMessage | null = null;

  beforeAll(async () => {
    if (!ok) return;
    dir = mkdtempSync(path.join(tmpdir(), 'harbor-ws-'));
    await ensureTlsCerts(dir, ['harbor.local']);
    app = createServer((_req, res) => res.end('plain'));
    app.on('upgrade', (req, socket) => {
      seen = req;
      if (req.url === '/refuse') {
        socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 2\r\n\r\nno');
        return;
      }
      const key = req.headers['sec-websocket-key'] as string;
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(key)}\r\nSec-WebSocket-Protocol: chat\r\n\r\n`);
      socket.on('data', (d) => socket.write(d)); // echo
      socket.on('end', () => socket.end()); // upgraded sockets are half-open: close when the proxy does
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    const appPort = (app.address() as AddressInfo).port;
    servers = new LanHttpsServers();
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    securePort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const { key, cert } = tlsKeyPair(dir);
    await servers.ensureAppProxy(securePort, appPort, key, cert);
  });
  afterAll(async () => {
    if (!ok) return;
    await servers.closeAll();
    app.closeAllConnections();
    await new Promise<void>((r) => app.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes the app's 101 through (accept key + subprotocol) and pipes frames both ways", async () => {
    if (!ok) return;
    const { res, socket } = await upgrade(securePort, '/ws/socket.io/?EIO=4&transport=websocket', { 'sec-websocket-protocol': 'chat' });
    expect(res.statusCode).toBe(101);
    expect(res.headers['sec-websocket-accept']).toBe(accept('dGhlIHNhbXBsZSBub25jZQ=='));
    expect(res.headers['sec-websocket-protocol']).toBe('chat');
    expect(seen!.headers['x-forwarded-proto']).toBe('https');
    expect(seen!.headers['x-forwarded-host']).toBe(`harbor.local:${securePort}`);
    const echoed = await new Promise<string>((resolve) => {
      socket!.once('data', (d: Buffer) => resolve(d.toString()));
      socket!.write('ping');
    });
    expect(echoed).toBe('ping');
    socket!.destroy();
  });

  it('passes a refusal back to the browser instead of hanging', async () => {
    if (!ok) return;
    const { res } = await upgrade(securePort, '/refuse');
    expect(res.statusCode).toBe(403);
    res.socket.destroy();
  });
});
