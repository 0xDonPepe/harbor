import { describe, expect, it } from 'vitest';
import { readTailnetAll, tailnetAllCandidates, tailnetAllState, tailnetReadiness, type TailnetAllCandidate, type TailnetAllMemory } from '../../src/lifecycle/tailnet-all.js';
import { FakeTailscale } from '../../src/exposure/tailscale.js';
import type { Repo } from '../../src/state/repo.js';

// Decision 177: which apps the every-app Tailscale policy plans for (pure selection).
const app = (id: string, over: Partial<TailnetAllCandidate> = {}): TailnetAllCandidate => ({ id, installState: 'installed', activeOperationId: null, runtime: 'running', readiness: 'healthy', tailnetUrl: null, hasPrimaryEndpoint: true, planOpen: false, ...over });
const mem = (over: Partial<{ except: string[]; attempted: string[]; failed: [string, string][]; inFlight: string[] }> = {}): TailnetAllMemory => ({ except: new Set(over.except ?? []), attempted: new Set(over.attempted ?? []), failed: new Map(over.failed ?? []), inFlight: new Set(over.inFlight ?? []) });

describe('every app gets a Tailscale address: selection (decision 177)', () => {
  it('plans for every running, answering app without a tailnet address, in order', () => {
    expect(tailnetAllCandidates([app('a'), app('b'), app('c')], mem())).toEqual(['a', 'b', 'c']);
  });

  it('never touches an app that already has a tailnet address', () => {
    const a = app('a', { tailnetUrl: 'https://h.ts.net:18999/' });
    expect(tailnetAllCandidates([a], mem())).toEqual([]);
    expect(tailnetAllState(a, mem())).toEqual({ state: 'published', note: null });
  });

  it('skips excluded, failed, in-flight and already-attempted apps', () => {
    const apps = [app('ex'), app('fail'), app('fly'), app('done'), app('ok')];
    const m = mem({ except: ['ex'], failed: [['fail', 'no port left.']], inFlight: ['fly'], attempted: ['fail', 'fly', 'done'] });
    expect(tailnetAllCandidates(apps, m)).toEqual(['ok']);
    expect(tailnetAllState(apps[0]!, m).state).toBe('excluded');
    expect(tailnetAllState(apps[1]!, m)).toEqual({ state: 'failed', note: 'no port left.' });
    expect(tailnetAllState(apps[2]!, m).state).toBe('pending');
    expect(tailnetAllState(apps[3]!, m).state).toBe('waiting');
  });

  it('waits for busy, stopped, unhealthy, installing and broken apps (they get their address later)', () => {
    const waiting = [app('busy', { activeOperationId: 'op' }), app('stopped', { runtime: 'stopped' }), app('sick', { readiness: 'unhealthy' }), app('new', { installState: 'installing' }), app('broken', { installState: 'needs_action' }), app('failed', { installState: 'failed' }), app('noep', { hasPrimaryEndpoint: false })];
    expect(tailnetAllCandidates(waiting, mem())).toEqual([]);
    for (const w of waiting) expect(tailnetAllState(w, mem()).state, w.id).toBe('waiting');
    expect(tailnetAllState(waiting[4]!, mem()).note).toMatch(/needs action/);
  });

  it('leaves an app alone while a plan for it is open for review (approving it would fail if the policy changed the app first)', () => {
    const a = app('a', { planOpen: true });
    expect(tailnetAllCandidates([a], mem())).toEqual([]);
    expect(tailnetAllState(a, mem())).toEqual({ state: 'waiting', note: expect.stringMatching(/open for review/) });
  });

  it('an excluded app that already has an address reads as published (the exception never withdraws it)', () => {
    expect(tailnetAllState(app('a', { tailnetUrl: 'https://h.ts.net:18990/' }), mem({ except: ['a'] })).state).toBe('published');
  });

  it('reads the stored policy defensively (absent = off, junk dropped)', () => {
    const repo = (v: unknown) => ({ setting: () => v }) as unknown as Repo;
    expect(readTailnetAll(repo(null))).toEqual({ enabled: false, except: [] });
    expect(readTailnetAll(repo({ enabled: true, except: ['a', 3, null] }))).toEqual({ enabled: true, except: ['a'] });
    expect(readTailnetAll(repo({ enabled: 'yes' }))).toEqual({ enabled: false, except: [] });
  });

  it('Tailscale readiness: not installed, not logged in, HTTPS off, ready', async () => {
    const ts = new FakeTailscale();
    expect(await tailnetReadiness(ts)).toEqual({ ready: true, hostname: 'harbor-test.tail1234.ts.net' });
    ts.statusValue = { ...ts.statusValue!, online: false };
    expect(await tailnetReadiness(ts)).toMatchObject({ ready: false, reason: expect.stringMatching(/offline/) });
    ts.statusValue = { ...ts.statusValue!, online: true, httpsEnabled: false };
    expect(await tailnetReadiness(ts)).toMatchObject({ ready: false, reason: expect.stringMatching(/HTTPS certificates are off/) });
    ts.statusValue = { ...ts.statusValue!, backendState: 'NeedsLogin', dnsName: null };
    expect(await tailnetReadiness(ts)).toMatchObject({ ready: false, reason: expect.stringMatching(/not logged in/) });
    ts.isInstalled = false;
    expect(await tailnetReadiness(ts)).toMatchObject({ ready: false, reason: expect.stringMatching(/not installed/), nextAction: expect.stringMatching(/--with-tailscale/) });
  });
});
