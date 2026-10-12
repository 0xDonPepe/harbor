import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TSX = createRequire(import.meta.url).resolve('tsx');

// A child that writes `bytes` to stdout, then ends the way the CLI does.
function child(bytes: number): number {
  const exitModule = path.join(ROOT, 'src', 'cli', 'exit.ts');
  const script = [
    `import { exitAfterFlush } from ${JSON.stringify(exitModule)};`,
    `process.stdout.write('x'.repeat(${bytes}));`,
    'exitAfterFlush(0);',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--import', TSX, '--input-type=module', '-e', script], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  expect(r.status).toBe(0);
  return r.stdout.length;
}

describe('CLI exit keeps piped output whole', () => {
  // the bug: process.exit() right after writing dropped what the pipe had not taken (`harbor --json catalog | …`
  // stopped at 65536 bytes with a large catalog)
  it('delivers every byte through a pipe, far past the 64 KiB a pipe holds', () => {
    expect(child(300_000)).toBe(300_000);
  });
});
