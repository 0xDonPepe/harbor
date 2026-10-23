import { describe, expect, it } from 'vitest';
import { restartBaseline, settleProblem, toleratedRestarts, type SettleContainer } from '../../scripts/smoke-settle.js';

const c = (over: Partial<SettleContainer> = {}): SettleContainer => ({ id: 'c1', service: 'web', running: true, exitCode: 0, restarts: 0, ...over });

describe('settleProblem', () => {
  it('passes running containers that never restarted', () => {
    expect(settleProblem([c(), c({ id: 'c2', service: 'db' })], new Map())).toBeNull();
  });

  it('names a stopped container and its exit code', () => {
    expect(settleProblem([c({ running: false, exitCode: 137 })], new Map())).toBe('web stopped (exit code 137)');
  });

  it('fails any restart when nothing is allowed (fresh install, the new revision)', () => {
    expect(settleProblem([c({ restarts: 1 })], new Map())).toBe('web restarted 1 time(s)');
  });

  it('allows the restarts a container already had at the baseline, and only those', () => {
    // the published revision's app crashed 5 times waiting for its database before Harbor said healthy
    const allowed = new Map([['c1', 5]]);
    expect(settleProblem([c({ restarts: 5 })], allowed)).toBeNull();
    expect(settleProblem([c({ restarts: 6 })], allowed)).toBe('web restarted 1 more time(s) after it was healthy');
  });

  it('matches by container id: a re-created container starts from zero', () => {
    // the update re-created web (new id); its old restarts do not cover the new container
    expect(settleProblem([c({ id: 'c9', restarts: 1 })], new Map([['c1', 5]]))).toBe('web restarted 1 time(s)');
  });
});

describe('toleratedRestarts', () => {
  it('names the restarts a baseline let through, for the phase message', () => {
    expect(toleratedRestarts([c({ restarts: 5 }), c({ id: 'c2', service: 'db' })], new Map([['c1', 5], ['c2', 0]]))).toBe('web restarted 5 time(s)');
    expect(toleratedRestarts([c()], new Map())).toBeNull();
  });
});

describe('restartBaseline', () => {
  it('maps container ids to restart counts', () => {
    expect([...restartBaseline([c({ restarts: 2 }), c({ id: 'c2', service: 'db' })])]).toEqual([['c1', 2], ['c2', 0]]);
  });
});
