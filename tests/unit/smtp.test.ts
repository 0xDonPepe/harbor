import { createServer, type Server, type Socket } from 'node:net';
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
