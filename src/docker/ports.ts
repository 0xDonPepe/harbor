import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';

// Real loopback bind probe. On Linux (and macOS) a wildcard/dual-stack listener on the same
// port makes this bind fail with EADDRINUSE, so the probe also covers 0.0.0.0/:: overlap.
export async function loopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

// Decision 163: a fixed UDP port is published on every interface, so probe the wildcard address
export async function udpPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createSocket({ type: 'udp4', reuseAddr: false });
    sock.unref();
    sock.once('error', () => resolve(false));
    sock.bind({ port, address: '0.0.0.0', exclusive: true }, () => sock.close(() => resolve(true)));
  });
}

export interface PortObserver {
  free(port: number): Promise<boolean>;
  // absent in older test doubles: treated as free
  udpFree?(port: number): Promise<boolean>;
}

export const realPortObserver: PortObserver = { free: loopbackPortFree, udpFree: udpPortFree };
