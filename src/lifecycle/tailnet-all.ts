import type { InstallState, PlanDto, PlanRequest, Readiness, Runtime, TailnetAllAppDto, TailnetAllAppState, TailnetAllDto } from '../contracts/api.js';
import type { TailscaleProvider } from '../exposure/tailscale.js';
import { exposureUrl } from '../exposure/urls.js';
import { HarborError } from '../errors.js';
import type { InstanceRow, Repo } from '../state/repo.js';
import type { Ctx } from './context.js';

// Decision 174: "Give every app a Tailscale address", an opt-in policy. The observer asks it once per tick (only on a
// tick that could see Docker); it never touches Docker or tailscale itself: each address is an ordinary expose plan
// (via tailnet, not the main address) submitted with actor `tailnet-policy` through the serial queue.

export const TAILNET_ALL_SETTING = 'exposure.tailnetAll';
export const TAILNET_POLICY_ACTOR = 'tailnet-policy';
export const TAILNET_ALL_NOTIFICATION = 'tailnet-all-failed';

export interface TailnetAllSetting {
  enabled: boolean;
  except: string[]; // instance ids the operator keeps off the tailnet
}

export function readTailnetAll(repo: Repo): TailnetAllSetting {
  const raw = repo.setting<Partial<TailnetAllSetting>>(TAILNET_ALL_SETTING);
  return { enabled: raw?.enabled === true, except: Array.isArray(raw?.except) ? raw.except.filter((x): x is string => typeof x === 'string') : [] };
}

// What the policy needs to know about one app (read from the repo by the caller; nothing here does I/O).
export interface TailnetAllCandidate {
  id: string;
  installState: InstallState;
  activeOperationId: string | null;
  runtime: Runtime;
  readiness: Readiness;
  tailnetUrl: string | null; // its tailnet address, when it has one (any endpoint)
  hasPrimaryEndpoint: boolean;
}

export interface TailnetAllMemory {
  except: ReadonlySet<string>;
  attempted: ReadonlySet<string>; // tried since this daemon started
  failed: ReadonlyMap<string, string>; // instance -> why
  inFlight: ReadonlySet<string>; // its policy operation is queued or running
}

// Where one app stands under the policy. `pending` = it gets a plan at the next check (or its plan is running).
// Every kind of primary endpoint counts, API endpoints too: a tailnet address is as useful to a script on a laptop
// as to a browser.
export function tailnetAllState(app: TailnetAllCandidate, mem: TailnetAllMemory): { state: TailnetAllAppState; note: string | null } {
  if (app.tailnetUrl) return { state: 'published', note: null };
  if (mem.except.has(app.id)) return { state: 'excluded', note: 'kept off the tailnet' };
  const why = mem.failed.get(app.id);
  if (why !== undefined) return { state: 'failed', note: why };
  if (mem.inFlight.has(app.id)) return { state: 'pending', note: 'getting its address now' };
  if (app.installState === 'installing') return { state: 'waiting', note: 'installing; it gets its address once it runs' };
  if (app.installState !== 'installed') return { state: 'waiting', note: `it is ${app.installState.replace('_', ' ')}; it gets its address once it runs again` };
  if (app.activeOperationId) return { state: 'waiting', note: 'another operation is running' };
  if (!app.hasPrimaryEndpoint) return { state: 'waiting', note: 'it has no address to publish' };
  if (app.runtime !== 'running') return { state: 'waiting', note: 'stopped; it gets its address when it runs' };
  if (app.readiness !== 'healthy') return { state: 'waiting', note: 'not answering yet; it gets its address once it does' };
  if (mem.attempted.has(app.id)) return { state: 'waiting', note: 'already published once since Harbor started; publish it again from its Publish dialog' };
  return { state: 'pending', note: 'gets its address at the next check' };
}

// The apps that need a plan now (in order): eligible, not tried yet since the daemon started, nothing in flight.
export function tailnetAllCandidates(apps: TailnetAllCandidate[], mem: TailnetAllMemory): string[] {
  return apps.filter((a) => !mem.inFlight.has(a.id) && tailnetAllState(a, mem).state === 'pending').map((a) => a.id);
}

export type TailnetReadiness = { ready: true; hostname: string } | { ready: false; reason: string; nextAction: string };

export async function tailnetReadiness(ts: TailscaleProvider): Promise<TailnetReadiness> {
  let st;
  try {
    st = await ts.status();
  } catch {
    st = null;
  }
  if (!st) {
    const installed = await ts.installed().catch(() => false);
    if (!installed) return { ready: false, reason: 'Tailscale is not installed on this machine', nextAction: 'Run once on the machine: sudo /opt/harbor/bin/harbor bootstrap --yes --with-tailscale, then log in under Settings → Remote access.' };
    return { ready: false, reason: 'Tailscale does not answer on this machine', nextAction: 'Check `tailscale status` on the machine, then try again.' };
  }
  if (st.backendState !== 'Running' || !st.dnsName) return { ready: false, reason: 'this machine is not logged in to your tailnet', nextAction: 'Log in under Settings → Remote access (or: harbor tailscale login).' };
  if (!st.httpsEnabled) return { ready: false, reason: 'HTTPS certificates are off for your tailnet', nextAction: 'In the Tailscale admin console, under DNS, turn on MagicDNS and click Enable HTTPS, then try again.' };
  return { ready: true, hostname: st.dnsName };
}

export interface TailnetAllHost {
  createPlan(req: PlanRequest, actor: string): Promise<PlanDto>;
  submit(planId: string, idempotencyKey: string, actor: string): { operation: { id: string } };
  instanceRow(idOrName: string): InstanceRow;
  primaryEndpointOf(i: InstanceRow): string;
}

export class TailnetAllPolicy {
  private readonly attempted = new Set<string>();
  private readonly failed = new Map<string, string>();
  private readonly inFlight = new Map<string, string>(); // instance -> operation
  constructor(
    private readonly ctx: Ctx,
    private readonly host: TailnetAllHost,
  ) {}

  // The stored policy, without exceptions for apps that no longer exist (purged). A removed app that Harbor keeps
  // for Reinstall keeps its exception, so Reinstall honours the operator's choice.
  setting(): TailnetAllSetting {
    const s = readTailnetAll(this.ctx.repo);
    const known = new Set(this.ctx.repo.listInstances().map((i) => i.id));
    const except = [...new Set(s.except.filter((id) => known.has(id)))];
    if (except.length !== s.except.length) this.write({ ...s, except });
    return { ...s, except };
  }

  private write(s: TailnetAllSetting): void {
    this.ctx.repo.setSetting(TAILNET_ALL_SETTING, s);
  }

  private candidates(): { row: InstanceRow; app: TailnetAllCandidate }[] {
    const { repo } = this.ctx;
    const out: { row: InstanceRow; app: TailnetAllCandidate }[] = [];
    for (const row of repo.listInstances()) {
      if (row.installState === 'retained') continue;
      const tailnet = repo.exposures(row.id).find((e) => e.via === 'tailnet');
      let primary: string | null = null;
      try {
        primary = this.host.primaryEndpointOf(row);
      } catch {
        primary = null;
      }
      out.push({ row, app: { id: row.id, installState: row.installState, activeOperationId: row.activeOperationId, runtime: row.runtime, readiness: row.readiness, tailnetUrl: tailnet ? exposureUrl(tailnet) : null, hasPrimaryEndpoint: primary !== null && row.endpoints.some((e) => e.id === primary) } });
    }
    return out;
  }

  private memory(except: string[]): TailnetAllMemory {
    return { except: new Set(except), attempted: this.attempted, failed: this.failed, inFlight: new Set(this.inFlight.keys()) };
  }

  async status(): Promise<TailnetAllDto> {
    const s = this.setting();
    this.collect();
    const r = await tailnetReadiness(this.ctx.tailscale);
    const mem = this.memory(s.except);
    const apps: TailnetAllAppDto[] = this.candidates().map(({ row, app }) => ({ instanceId: row.id, name: row.displayName ?? row.name, url: app.tailnetUrl, ...tailnetAllState(app, mem) }));
    return { enabled: s.enabled, status: !s.enabled ? 'off' : r.ready ? 'on' : 'waiting', reason: r.ready ? null : r.reason, nextAction: r.ready ? null : r.nextAction, except: s.except, apps };
  }

  // Turning it on is refused while Tailscale cannot publish anything; turning it off never withdraws an address.
  async setEnabled(enabled: boolean): Promise<TailnetAllDto> {
    const s = this.setting();
    if (enabled) {
      const r = await tailnetReadiness(this.ctx.tailscale);
      if (!r.ready) throw new HarborError('UNSUPPORTED_CAPABILITY', `every app cannot get a Tailscale address yet: ${r.reason}`, { nextAction: r.nextAction });
      if (!s.enabled) {
        // a fresh start of the policy: every app gets one attempt again
        this.attempted.clear();
        this.failed.clear();
      }
    }
    this.write({ ...s, enabled });
    if (!enabled) this.resolveAll();
    this.ctx.log.info(`every-app Tailscale addresses ${enabled ? 'on' : 'off'}`, {});
    return this.status();
  }

  // The per-app switch. Excluding never withdraws the current address; including clears the exception and any
  // failed attempt, so the policy publishes it at its next check.
  async setIncluded(idOrName: string, included: boolean): Promise<TailnetAllDto> {
    const inst = this.host.instanceRow(idOrName);
    const s = this.setting();
    const except = included ? s.except.filter((x) => x !== inst.id) : [...new Set([...s.except, inst.id])];
    this.write({ ...s, except });
    if (included) {
      this.attempted.delete(inst.id);
      this.failed.delete(inst.id);
    }
    this.ctx.notifier.resolve(`tailnet-all:${inst.id}`);
    this.ctx.repo.addEvent({ instanceId: inst.id, phase: 'policy', message: included ? 'included in "every app gets a Tailscale address" again' : 'kept off the tailnet by the "every app gets a Tailscale address" policy (its current address, if any, stays)' });
    return this.status();
  }

  // The operator withdrew an app's tailnet address while the policy is on: keep it off from now on.
  operatorWithdrew(instanceId: string): void {
    const s = this.setting();
    if (!s.enabled || s.except.includes(instanceId)) return;
    this.write({ ...s, except: [...s.except, instanceId] });
    this.ctx.repo.addEvent({ instanceId, phase: 'policy', message: 'its Tailscale address was withdrawn by hand: the "every app gets a Tailscale address" policy leaves it off the tailnet from now on' });
  }

  // A line for the install plan (decision 174): the new app gets its address after it starts.
  async installNote(): Promise<string | null> {
    if (!readTailnetAll(this.ctx.repo).enabled) return null;
    const r = await tailnetReadiness(this.ctx.tailscale);
    return r.ready ? 'It also gets an address on your tailnet once it runs (every app gets a Tailscale address).' : `It also gets an address on your tailnet once it runs and Tailscale is ready (${r.reason}).`;
  }

  private resolveAll(): void {
    for (const n of this.ctx.repo.notifications({ limit: 500 })) if (n.kind === TAILNET_ALL_NOTIFICATION) this.ctx.notifier.resolve(n.dedupeKey);
  }

  private fail(row: InstanceRow, why: string): void {
    this.failed.set(row.id, why);
    const label = row.displayName ?? row.name;
    this.ctx.notifier.notify({ kind: TAILNET_ALL_NOTIFICATION, severity: 'warning', title: `${label} did not get its Tailscale address`, body: `${why} Harbor tries once per start. Try again from Settings → Remote access, or publish it from its Publish dialog.`, instanceId: row.id, dedupeKey: `tailnet-all:${row.id}` });
    this.ctx.log.warn(`tailnet-policy could not publish ${row.name}: ${why}`, { instanceId: row.id });
  }

  // How the operations this policy submitted ended.
  private collect(): void {
    for (const [instanceId, operationId] of [...this.inFlight]) {
      const op = this.ctx.repo.operation(operationId);
      if (!op) {
        this.inFlight.delete(instanceId);
        continue;
      }
      if (op.state !== 'succeeded' && op.state !== 'failed' && op.state !== 'needs_action') continue;
      this.inFlight.delete(instanceId);
      const row = this.ctx.repo.instance(instanceId);
      if (op.state === 'succeeded') this.ctx.notifier.resolve(`tailnet-all:${instanceId}`);
      else if (row) this.fail(row, `${op.errorMessage ?? `the operation ${op.state === 'failed' ? 'failed' : 'needs attention'}`}${/[.!?]$/.test(op.errorMessage ?? '') ? '' : '.'}`);
    }
  }

  // Called by the observer on a tick that saw Docker. One plan at a time, and only while no other operation runs:
  // a tailnet port is picked at plan time, so two plans made together could pick the same one.
  async reconcile(): Promise<void> {
    const s = this.setting();
    this.collect();
    // a failure notification goes when its condition does (policy off, app kept off, published or retried later)
    for (const n of this.ctx.repo.notifications({ limit: 500 })) {
      if (n.kind !== TAILNET_ALL_NOTIFICATION || !n.instanceId) continue;
      if (!s.enabled || !this.failed.has(n.instanceId) || s.except.includes(n.instanceId)) this.ctx.notifier.resolve(n.dedupeKey);
    }
    if (!s.enabled || this.inFlight.size) return;
    if (this.ctx.repo.listInstances().some((i) => i.activeOperationId)) return;
    const all = this.candidates();
    const next = tailnetAllCandidates(
      all.map((c) => c.app),
      this.memory(s.except),
    )[0];
    if (!next) return;
    if (!(await tailnetReadiness(this.ctx.tailscale)).ready) return;
    const row = all.find((c) => c.row.id === next)!.row;
    this.attempted.add(row.id);
    try {
      const plan = await this.host.createPlan({ kind: 'expose', instanceId: row.id, via: 'tailnet', makePrimary: false }, TAILNET_POLICY_ACTOR);
      const r = this.host.submit(plan.id, this.ctx.ids.uuid(), TAILNET_POLICY_ACTOR);
      this.inFlight.set(row.id, r.operation.id);
      this.ctx.log.info(`tailnet-policy publishes ${row.name} on the tailnet`, { instanceId: row.id, operationId: r.operation.id });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.fail(row, `${msg}${/[.!?]$/.test(msg) ? '' : '.'}`);
    }
  }
}
