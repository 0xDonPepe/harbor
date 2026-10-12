import type { Manifest, ManifestPermission } from '../contracts/types.js';
import type { FixedPortDto, PermissionDto } from '../contracts/api.js';

// Decision 163: what each permission lets an app do, in the words the operator approves
export const PERMISSION_LABEL: Readonly<Record<ManifestPermission, string>> = {
  'net-admin': 'Change network settings inside the app: create network tunnels, routes and firewall rules (NET_ADMIN)',
  tun: "Use this machine's tunnel device, /dev/net/tun",
  'ip-forwarding': 'Pass traffic between networks inside the app (IP forwarding)',
};

const ORDER: readonly ManifestPermission[] = ['net-admin', 'tun', 'ip-forwarding'];

// Pure: every (service, permission) the manifest asks for, in a stable order
export function permissionsOf(manifest: Manifest): { service: string; permission: ManifestPermission }[] {
  return Object.keys(manifest.permissions ?? {})
    .sort()
    .flatMap((service) => ORDER.filter((p) => manifest.permissions![service]!.includes(p)).map((permission) => ({ service, permission })));
}

// Pure: what `next` asks for that `current` did not (an update needs the operator to accept only these)
export function newPermissions(current: Manifest | null, next: Manifest): { service: string; permission: ManifestPermission }[] {
  const had = new Set(current ? permissionsOf(current).map((p) => `${p.service}:${p.permission}`) : []);
  return permissionsOf(next).filter((p) => !had.has(`${p.service}:${p.permission}`));
}

export function permissionDto(p: { service: string; permission: ManifestPermission }): PermissionDto {
  return { ...p, label: PERMISSION_LABEL[p.permission] };
}

// Pure: the fixed ports, sorted by id
export function fixedPortsOf(manifest: Manifest): FixedPortDto[] {
  return Object.entries(manifest.ports ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, p]) => ({ id, service: p.service, protocol: p.protocol, hostPort: p.hostPort, containerPort: p.containerPort, purpose: p.purpose }));
}

// the claim key a fixed port is recorded under (port_claims.endpoint_id)
export const fixedPortClaim = (id: string): string => `port:${id}`;
