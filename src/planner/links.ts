import type { LinkFormat } from '../contracts/types.js';
import { LABELS } from '../naming.js';
import { instanceLabels, type InstanceIdentity } from './identity.js';

// App links (decision 126): pure naming and value rules. One Docker network per (consumer, link id),
// owned by the consumer instance and labelled like every Harbor resource; only the consumer's bound
// services and the provider's endpoint service join it. The provider answers on it as `<id>-link`.
// Decision 171: the runner attaches both sides itself, never Compose: Compose names every container it
// attaches after its service, and a container on several networks resolves a name on any of them, so a
// consumer service called `db` would answer the provider's own `db` lookups while the provider's db is down.

export function linkAlias(linkId: string): string {
  return `${linkId}-link`;
}

export function linkNetworkName(consumer: InstanceIdentity, linkId: string): string {
  return `${consumer.project}_link_${linkId}`;
}

export function linkNetworkLabels(consumer: InstanceIdentity, linkId: string, providerInstanceId: string): Record<string, string> {
  return instanceLabels(consumer, { [LABELS.kind]: 'link', [LABELS.link]: linkId, [LABELS.provider]: providerInstanceId });
}

// What a consumer's variable receives. `url` has no trailing slash: base URLs get paths appended.
export function linkValue(alias: string, containerPort: number, format: LinkFormat = 'url'): string {
  switch (format) {
    case 'url':
      return `http://${alias}:${containerPort}`;
    case 'authority':
      return `${alias}:${containerPort}`;
    case 'host':
      return alias;
    case 'port':
      return String(containerPort);
  }
}

// Decision 171: does a container answer to other names on a link network than the ones Harbor gives it
// (the consumer's bound services none, the provider's endpoint service `<id>-link`)? Docker always adds
// the container's own name and its 12-character short id (older engines list the id among the aliases,
// Compose lists the name): both are unique and Harbor-made, never a name an app looks up. Anything else
// (a service name Compose added before 0.32.0) is drift, and so is a wanted alias that is missing.
export function linkAliasesDrift(actual: readonly string[], wanted: readonly string[], container: { id: string; name: string }): boolean {
  const own = (a: string) => a === container.name || (a.length === 12 && container.id.startsWith(a));
  return actual.some((a) => !wanted.includes(a) && !own(a)) || wanted.some((w) => !actual.includes(w));
}
