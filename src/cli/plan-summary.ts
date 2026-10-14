import type { GpuDto, PlanDto, PlanSettingDto } from '../contracts/api.js';
import { gpuProblemText } from '../planner/gpu.js';
import { formatSettingValue } from '../planner/settings.js';

// What `harbor plan` / `harbor install` print for a plan (also on stderr before an apply). Its notes carry
// the plain facts, e.g. decision 170's "You already have X. This installs a separate copy…".
function encryptionLine(location: PlanDto['location']): string {
  return location ? `  Encrypted: yes — sealed at ${location.dir}` : '  Encrypted: no — plain Docker volumes (readable on disk, starts on its own after a reboot)';
}

// Decision 179: what this machine offers an app that asks for its graphics card
export function gpuFact(g: GpuDto): string {
  const p = gpuProblemText(g.problem);
  if (g.kind === 'nvidia') return `${g.detail} (ready for apps)`;
  if (g.kind === 'dri') return `${g.detail}${p ? `; an NVIDIA card is also here, but ${p.what} (${p.next})` : ''}`;
  if (p) return `${g.detail} found, but ${p.what}: runs on the CPU until then (${p.next})`;
  return 'no usable graphics card found: runs on the CPU';
}

// Decision 180: one line per setting a plan lists (asked ones show their default and how to choose another)
export function settingLine(x: PlanSettingDto): string {
  const v = (y: PlanSettingDto['value']) => formatSettingValue(x, y);
  if (x.change === 'dropped') return `${x.label} (${x.id}): no longer part of this release${x.previous !== null ? `; your value ${v(x.previous)} is dropped` : ''}`;
  if (x.change === 'reset') return `${x.label} (${x.id}): back to the default ${v(x.default)}${x.previous !== null ? ` (${v(x.previous)} is no longer allowed)` : ''}`;
  if (x.change === 'set') return `${x.label} (${x.id}): ${x.previous !== null ? `${v(x.previous)} -> ` : ''}${v(x.value)}${x.value === x.default ? ' (default)' : ''}`;
  return `${x.label} (${x.id}): ${v(x.default)} (default; --set ${x.id}=<value> to choose)`;
}

export function planSummary(p: PlanDto): string {
  const lines = [`Plan ${p.id} (${p.kind}) for "${p.name}" [${p.packageId} rev ${p.revision}] — expires ${p.expiresAt}`];
  for (const c of p.changes) lines.push(`  - ${c}`);
  if (p.kind === 'install') lines.push(encryptionLine(p.location));
  if (p.endpoints.length) lines.push('  Endpoints: ' + p.endpoints.map((e) => `${e.id}=${e.browserUrl}`).join(', '));
  for (const x of p.ports ?? []) lines.push(`  Port:      ${x.protocol.toUpperCase()} ${x.hostPort} on every network (${x.purpose}); forward it on your router to reach it from outside`);
  for (const x of p.permissions ?? []) lines.push(`  Permission: ${x.service}: ${x.label}`);
  if (p.gpu) lines.push(`  GPU:       ${gpuFact(p.gpu)}`);
  if (p.storage.length) lines.push('  Storage:   ' + p.storage.map((s) => `${s.volumeName} (${s.state})`).join(', '));
  if (p.secrets.length) lines.push('  Secrets:   ' + p.secrets.map((s) => `${s.id} (${s.source === 'operator' ? (s.ask ? `you provide it${s.ask === 'optional' ? ', optional' : ''}` : 'kept') : s.state})`).join(', '));
  for (const x of p.settings ?? []) lines.push(`  Setting:   ${settingLine(x)}`);
  for (const l of p.links ?? []) lines.push(`  Link:      ${l.id} -> ${l.provider ? `${l.provider.name}/${l.provider.endpointId} as ${l.provider.url}` : 'no provider'}${l.change === 'keep' ? ' (unchanged)' : l.change === 'clear' ? ' (unlink)' : ''}`);
  if (p.exposure) lines.push(`  Address:   ${p.exposure.url} via ${p.exposure.via}, protection ${p.exposure.protection}${p.exposure.makePrimary ? ', becomes primary' : ''}`);
  for (const w of p.warnings) lines.push(`  ! ${w}`);
  for (const n of p.notes ?? []) lines.push(`  · ${n}`);
  return lines.join('\n');
}
