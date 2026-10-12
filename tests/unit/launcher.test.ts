import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ASSETS = path.resolve(import.meta.dirname, '../../release-assets/bin');

// The release launchers find the bundled runtime next to the REAL script, also when called through a
// symlink such as /usr/local/bin/harbor (0.28.2).
describe('release launchers', () => {
  for (const [name, entry] of [['harbor', 'dist/cli/main.js'], ['harbor-daemon', 'dist/daemon.js']] as const) {
    it(`${name} works through a symlink in another directory`, () => {
      const root = mkdtempSync(path.join(tmpdir(), 'harbor-launcher-'));
      const opt = path.join(root, 'opt', 'harbor');
      mkdirSync(path.join(opt, 'bin'), { recursive: true });
      mkdirSync(path.join(opt, 'node', 'bin'), { recursive: true });
      copyFileSync(path.join(ASSETS, name), path.join(opt, 'bin', name));
      chmodSync(path.join(opt, 'bin', name), 0o755);
      // a fake runtime that prints what it was asked to run
      writeFileSync(path.join(opt, 'node', 'bin', 'node'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      const bin = path.join(root, 'usr', 'local', 'bin');
      mkdirSync(bin, { recursive: true });
      symlinkSync(path.join(opt, 'bin', name), path.join(bin, name));
      const out = execFileSync(path.join(bin, name), ['catalog', 'status'], { encoding: 'utf8' }).trim().split('\n');
      expect(out[0]).toBe(path.join(realpathSync(opt), entry));
      expect(out.slice(1)).toEqual(['catalog', 'status']);
    });
  }
});
