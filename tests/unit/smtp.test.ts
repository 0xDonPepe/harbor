import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import { tempDir } from './helpers.js';
import { afterEach, describe, expect, it } from 'vitest';
import { sendSmtp, smtpAddressOk } from '../../src/notify/smtp.js';
import type { EmailChannel } from '../../src/notify/notifier.js';

// Decision 169: AUTH only inside TLS; addresses are one line.
interface FakeSmtp {
  server: Server;
  port: number;
  lines: string[];
  connections: number;
}

async function fakeSmtp(opts: { starttls: 'none' | 'refused' }): Promise<FakeSmtp> {
  const st: FakeSmtp = { server: createServer(), port: 0, lines: [], connections: 0 };
  st.server.on('connection', (sock: Socket) => {
    st.connections += 1;
    let buf = '';
    let inData = false;
    sock.write('220 fake.smtp ready\r\n');
    sock.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        st.lines.push(line);
        if (inData) {
          if (line === '.') {
            inData = false;
            sock.write('250 queued\r\n');
          }
          continue;
        }
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') sock.write(opts.starttls === 'none' ? '250-fake.smtp\r\n250 AUTH LOGIN\r\n' : '250-fake.smtp\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n');
        else if (verb === 'STARTTLS') sock.write('454 TLS not available right now\r\n');
        else if (verb === 'AUTH') sock.write('334 VXNlcm5hbWU6\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT') sock.write('250 ok\r\n');
        else if (verb === 'DATA') {
          inData = true;
          sock.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('334 x\r\n');
      }
    });
  });
  await new Promise<void>((r) => st.server.listen(0, '127.0.0.1', () => r()));
  st.port = (st.server.address() as { port: number }).port;
  return st;
}

const channel = (port: number, extra: Partial<EmailChannel['smtp']> = {}, addr: Partial<Pick<EmailChannel, 'from' | 'to'>> = {}): EmailChannel => ({
  kind: 'email',
  smtp: { host: '127.0.0.1', port, secure: false, ...extra },
  from: addr.from ?? 'harbor@example.test',
  to: addr.to ?? 'admin@example.test',
});

let open: FakeSmtp | null = null;
afterEach(async () => {
  if (open) await new Promise<void>((r) => open!.server.close(() => r()));
  open = null;
});

describe('SMTP client', () => {
  it('sends without a password over a plain connection (no AUTH needed)', async () => {
    open = await fakeSmtp({ starttls: 'none' });
    const r = await sendSmtp(channel(open.port), 'Hello', 'body');
    expect(r).toEqual({ ok: true, error: null });
    expect(open.lines).toContain('MAIL FROM:<harbor@example.test>');
  });

  it('never sends AUTH in clear: a server without STARTTLS gets no password', async () => {
    open = await fakeSmtp({ starttls: 'none' });
    const r = await sendSmtp(channel(open.port, { user: 'harbor', pass: 'smtp-FIXTURE-password' }), 'Hello', 'body');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/offers no encryption/);
    expect(open.lines.some((l) => /^AUTH/i.test(l))).toBe(false);
    expect(open.lines.join('\n')).not.toContain(Buffer.from('smtp-FIXTURE-password').toString('base64'));
  });

  it('a STARTTLS the server offers but refuses stops before AUTH', async () => {
    open = await fakeSmtp({ starttls: 'refused' });
    const r = await sendSmtp(channel(open.port, { user: 'harbor', pass: 'smtp-FIXTURE-password' }), 'Hello', 'body');
    expect(r.ok).toBe(false);
    expect(open.lines.some((l) => /^AUTH/i.test(l))).toBe(false);
  });

  it('refuses a line break in from or to without connecting', async () => {
    open = await fakeSmtp({ starttls: 'none' });
    expect(smtpAddressOk('a@b.test')).toBe(true);
    expect(smtpAddressOk('a@b.test\r\nRCPT TO:<x@evil.test>')).toBe(false);
    const r = await sendSmtp(channel(open.port, {}, { to: 'admin@example.test>\r\nRCPT TO:<x@evil.test' }), 'Hello', 'body');
    expect(r).toEqual({ ok: false, error: 'the from and to addresses must be one line each' });
    const r2 = await sendSmtp(channel(open.port, {}, { from: 'harbor@example.test\n' }), 'Hello', 'body');
    expect(r2.ok).toBe(false);
    expect(open.connections).toBe(0);
  });
});

// A throwaway self-signed certificate for localhost, made with openssl for this run only.
function throwawayCert(): { key: string; cert: string } {
  const dir = tempDir('harbor-smtp-tls-');
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
}

// An SMTP server that really encrypts: STARTTLS upgrades the socket (or the whole connection is TLS from the
// start). `lines` records what arrived and whether it arrived inside TLS.
interface TlsSmtp {
  server: Server;
  port: number;
  lines: { line: string; tls: boolean }[];
}
async function tlsSmtp(mode: 'starttls' | 'implicit', pem: { key: string; cert: string }): Promise<TlsSmtp> {
  const st: TlsSmtp = { server: null as unknown as Server, port: 0, lines: [] };
  const serve = (sock: Socket, tls: boolean, greet: boolean): void => {
    let buf = '';
    let inData = false;
    let authStep = 0;
    if (greet) sock.write('220 fake.smtp ready\r\n');
    const onData = (d: Buffer) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        st.lines.push({ line, tls });
        if (inData) {
          if (line === '.') {
            inData = false;
            sock.write('250 queued\r\n');
          }
          continue;
        }
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') sock.write(tls ? '250-fake.smtp\r\n250 AUTH LOGIN\r\n' : '250-fake.smtp\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n');
        else if (verb === 'STARTTLS') {
          sock.off('data', onData);
          sock.write('220 go ahead\r\n', () => serve(new TLSSocket(sock, { isServer: true, key: pem.key, cert: pem.cert }), true, false));
          return;
        } else if (verb === 'AUTH') {
          authStep = 1;
          sock.write('334 VXNlcm5hbWU6\r\n'); // "Username:"
        } else if (authStep === 1) {
          authStep = 2;
          sock.write('334 UGFzc3dvcmQ6\r\n'); // "Password:"
        } else if (authStep === 2) {
          authStep = 3;
          sock.write('235 authenticated\r\n');
        } else if (verb === 'MAIL' || verb === 'RCPT') sock.write('250 ok\r\n');
        else if (verb === 'DATA') {
          inData = true;
          sock.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          sock.write('221 bye\r\n');
          sock.end();
        } else sock.write('500 unknown\r\n');
      }
    };
    sock.on('data', onData);
    sock.on('error', () => {});
  };
  st.server = mode === 'implicit' ? createTlsServer({ key: pem.key, cert: pem.cert }, (s) => serve(s, true, true)) : createServer((s) => serve(s, false, true));
  await new Promise<void>((r) => st.server.listen(0, '127.0.0.1', () => r()));
  st.port = (st.server.address() as { port: number }).port;
  return st;
}

describe('SMTP client with a server that encrypts', () => {
  const pem = throwawayCert();
  let srv: TlsSmtp | null = null;
  afterEach(async () => {
    if (srv) await new Promise<void>((r) => srv!.server.close(() => r()));
    srv = null;
  });
  const login = (port: number, secure: boolean): EmailChannel => ({ kind: 'email', smtp: { host: 'localhost', port, secure, user: 'harbor', pass: 'pw-FIXTURE' }, from: 'harbor@example.test', to: 'admin@example.test' });

  it('after a STARTTLS that succeeded, AUTH is sent, and only inside TLS', async () => {
    srv = await tlsSmtp('starttls', pem);
    const r = await sendSmtp(login(srv.port, false), 'hello', 'body', { ca: pem.cert });
    expect(r).toEqual({ ok: true, error: null });
    const auth = srv.lines.findIndex((l) => l.line === 'AUTH LOGIN');
    expect(auth).toBeGreaterThan(0);
    expect(srv.lines.slice(0, srv.lines.findIndex((l) => l.line === 'STARTTLS') + 1).every((l) => !l.tls)).toBe(true);
    expect(srv.lines.slice(auth).every((l) => l.tls)).toBe(true);
    expect(srv.lines.some((l) => l.line === Buffer.from('pw-FIXTURE').toString('base64') && l.tls)).toBe(true);
  });

  it('with implicit TLS (secure, usually port 465) AUTH is sent', async () => {
    srv = await tlsSmtp('implicit', pem);
    const r = await sendSmtp(login(srv.port, true), 'hello', 'body', { ca: pem.cert });
    expect(r).toEqual({ ok: true, error: null });
    expect(srv.lines.some((l) => l.line === 'AUTH LOGIN')).toBe(true);
    expect(srv.lines.every((l) => l.tls)).toBe(true);
  });

  it('a server certificate the machine does not trust stops before AUTH', async () => {
    srv = await tlsSmtp('starttls', pem);
    const r = await sendSmtp(login(srv.port, false), 'hello', 'body');
    expect(r.ok).toBe(false);
    expect(srv.lines.some((l) => l.line === 'AUTH LOGIN')).toBe(false);
  });
});

