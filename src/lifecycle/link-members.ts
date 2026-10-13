import path from 'node:path';
import type { ContainerInfo, NetworkInfo } from '../docker/adapter.js';
import { LABELS } from '../naming.js';
import { linkAlias, linkAliasesDrift } from '../planner/links.js';
import type { LinkRow } from '../state/repo.js';
import type { Ctx } from './context.js';
import { instanceDir, loadReleaseSnapshot } from './instance-dir.js';

// App links (decisions 126, 171): which containers sit on a link network and under which names. Shared by
// the runner (which attaches them) and the observer's one-time check after an upgrade (which only reads).

export interface LinkMember {
  id: string;
  aliases: string[];
}

// Ownership of a link network: this installation, the consumer instance, kind link, this link id.
export function ownsLinkNetwork(ctx: Pick<Ctx, 'installationId'>, net: NetworkInfo, l: LinkRow): boolean {
  return net.labels[LABELS.installation] === ctx.installationId && net.labels[LABELS.instance] === l.consumerInstanceId && net.labels[LABELS.kind] === 'link' && net.labels[LABELS.link] === l.linkId;
}

// Containers that sit on a link network: the consumer's bound services (no name of their own there), or the
// provider's endpoint service (answers as `<id>-link`).
export function linkMembers(ctx: Pick<Ctx, 'repo' | 'config'>, l: LinkRow, side: 'consumer' | 'provider'): LinkMember[] {
  const { repo } = ctx;
  if (side === 'provider') {
    const prov = l.providerInstanceId ? repo.instance(l.providerInstanceId) : null;
    const svc = prov?.endpoints.find((e) => e.id === l.providerEndpoint)?.service;
    if (!prov || !svc) return [];
    return repo.resources(prov.id).filter((r) => r.kind === 'container' && r.role === svc && r.dockerId).map((r) => ({ id: r.dockerId!, aliases: [linkAlias(l.linkId)] }));
  }
  const consumer = repo.instance(l.consumerInstanceId);
  if (!consumer) return [];
  let services: string[] = [];
  try {
    const pkg = loadReleaseSnapshot(path.join(instanceDir(ctx.config.stateDir, consumer.id), 'release'), consumer.packageId);
    services = (pkg.manifest.links ?? []).find((c) => c.id === l.linkId)?.bindings.map((b) => b.service) ?? [];
  } catch {
    return [];
  }
  return repo.resources(consumer.id).filter((r) => r.kind === 'container' && services.includes(r.role) && r.dockerId).map((r) => ({ id: r.dockerId!, aliases: [] }));
}

// The aliases a container has on a network: undefined when it is not attached, null when it is but the
// adapter cannot tell its aliases. Looked up by network name: Docker leaves NetworkID empty on every
// network of a container that never started.
export function aliasesOn(c: ContainerInfo, net: NetworkInfo): string[] | null | undefined {
  const byName = c.networkAliases?.[net.name];
  if (byName) return byName;
  return c.networkIds.includes(net.id) ? null : undefined;
}

// Read only (the observer's check after an upgrade): the containers of one active link that answer on its
// network to a name Harbor did not give them (what Compose left there before 0.32.0).
export async function linkNameDrift(ctx: Pick<Ctx, 'repo' | 'config' | 'docker' | 'installationId'>, l: LinkRow): Promise<string[]> {
  if (l.state !== 'active' || !l.providerInstanceId) return [];
  const net = await ctx.docker.inspectNetwork(l.networkId ?? l.networkName);
  if (!net || !ownsLinkNetwork(ctx, net, l)) return [];
  const drifting: string[] = [];
  for (const side of ['consumer', 'provider'] as const) {
    for (const m of linkMembers(ctx, l, side)) {
      const c = await ctx.docker.inspectContainer(m.id);
      if (!c) continue;
      const actual = aliasesOn(c, net);
      if (actual && linkAliasesDrift(actual, m.aliases, c)) drifting.push(c.name);
    }
  }
  return drifting;
}
