import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceSummary, PackageImportResultDto } from '../../src/contracts/api.js';
import { writeZip } from '../../src/packages/zip.js';
import { projectNameFor } from '../../src/naming.js';
import { startHarness, type Harness } from './harness.js';

// Decision 171: names on a link network. Compose gives every service it attaches its own service name as a
// name on each network, and a container on several networks resolves a name on any of them (checked on
// Docker 29: the app's own network answers first, but while the provider's `db` is stopped its `server`
// resolved `db` to the consumer's container on the link network). So the runner attaches both sides itself,
// with only the names Harbor chooses: the consumer's bound services none, the provider's endpoint service
// `<id>-link`. Here the consumer's bound service is deliberately called `db` and its other one `web`, both
// names the provider also uses.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const head = (id: string, services: string, port = 80) => `apiVersion: harbor/v1alpha1
kind: Application
metadata:
  id: ${id}
  name: ${id}
  description: ${id} for the link names tests
release:
  revision: "1"
deployment:
  compose: compose.yaml
  multiInstance: false
  services:
${services}
endpoints:
  web:
    service: web
    containerPort: ${port}
    scheme: http
    exposure: direct
    browserContext: ordinary
health:
  endpoint: web
  path: /
  expectedStatus: [200]
  timeoutSeconds: 5
  deadlineSeconds: 30
ui:
  primaryEndpoint: web
`;
const provider = head('namedocs', '    web: application\n    db: infrastructure', 3010);
const consumer =
  head('shadowish', '    web: application\n    db: application') +
  `links:
  - id: docs
    purpose: The documents app it reads
    provider: {packages: [namedocs]}
    bindings:
      - {service: db, environment: DOCS_BASE_URL}
`;
const composeOf = (services: string[]) => `services:\n${services.map((s) => `  ${s}:\n    image: nginx:1.27-alpine\n`).join('')}`;
const upload = (m: string, services: string[]) => h.api.expect<PackageImportResultDto>(201, 'POST', '/v1/packages', { fileName: 'p.zip', dataUrl: `data:application/zip;base64,${writeZip({ 'manifest.yaml': m, 'compose.yaml': composeOf(services) }).toString('base64')}` });
const byName = async (name: string) => (await h.api.instances()).find((i) => i.name === name)!;
const runtime = (id: string) => readFileSync(path.join(h.stateDir, 'instances', id, 'runtime', 'compose.yaml'), 'utf8');
const containerNamed = (name: string) => [...h.fake.containers.values()].find((c) => c.name === name)!;
const networkNamed = (name: string) => [...h.fake.networks.values()].find((n) => n.name === name)!;

describe('link networks carry only the names Harbor gives (decision 171)', () => {
  let docs: InstanceSummary;
  let shadow: InstanceSummary;
  let net: string;
  let consumerDb: string; // the consumer's bound service, named `db`
  let providerWeb: string; // the provider's endpoint service
  const clean = () => {
    expect(new Set(networkNamed(net).containerIds)).toEqual(new Set([containerNamed(consumerDb).id, containerNamed(providerWeb).id]));
    expect(h.fake.aliasesOn(consumerDb, net)).toEqual([]);
    expect(h.fake.aliasesOn(providerWeb, net)).toEqual(['docs-link']);
    const names = h.fake.namesOn(net);
    expect(names).toContain('docs-link');
    expect(names).not.toContain('db');
    expect(names).not.toContain('web');
  };
  // How 0.31.0 and older left them: Compose attached both sides and added each service name.
  const legacy = async () => {
    const n = networkNamed(net);
    for (const [name, svc, extra] of [
      [consumerDb, 'db', []],
      [providerWeb, 'web', ['docs-link']],
    ] as const) {
      await h.fake.disconnectNetwork(n.id, containerNamed(name).id);
      await h.fake.connectNetwork(n.id, containerNamed(name).id, [name, svc, ...extra]);
    }
    expect(h.fake.namesOn(net)).toEqual(expect.arrayContaining(['db', 'web']));
  };

  it('install: the consumer service called db answers to no name on the link network, the provider only to docs-link', async () => {
    await upload(provider, ['web', 'db']);
    await upload(consumer, ['web', 'db']);
    expect((await h.api.run({ kind: 'install', packageId: 'namedocs' })).op.state).toBe('succeeded');
    const { plan, op } = await h.api.run({ kind: 'install', packageId: 'shadowish' });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    docs = await byName('namedocs');
    shadow = await byName('shadowish');
    net = plan.links[0]!.network;
    consumerDb = `${projectNameFor(shadow.id)}-db-1`;
    providerWeb = `${projectNameFor(docs.id)}-web-1`;
    clean();
    // the provider's db and the consumer's web never join
    expect(networkNamed(net).containerIds).not.toContain(containerNamed(`${projectNameFor(docs.id)}-db-1`).id);
    expect(networkNamed(net).containerIds).not.toContain(containerNamed(`${projectNameFor(shadow.id)}-web-1`).id);
    // the address the consumer gets is unchanged
    expect(h.fake.envOf(consumerDb)?.['DOCS_BASE_URL']).toBe('http://docs-link:3010');
    // neither Compose file mentions the link network, so Compose never names anything on it
    expect(runtime(shadow.id)).not.toContain(net);
    expect(runtime(docs.id)).not.toContain(net);
    expect(runtime(docs.id)).not.toContain('docs-link');
  });

  it('the consumer is on the link network before it starts (create, attach, then start)', async () => {
    const project = projectNameFor(shadow.id);
    const from = h.fake.log.length;
    expect((await h.api.run({ kind: 'restart', instanceId: shadow.id })).op.state).toBe('succeeded');
    const log = h.fake.log.slice(from);
    const create = log.indexOf(`up ${project} --no-start --force-recreate`);
    const attach = log.indexOf(`network connect ${net} ${consumerDb}`);
    const start = log.indexOf(`up ${project}`);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(attach).toBeGreaterThan(create);
    expect(start).toBeGreaterThan(attach);
    clean();
  });

  it('Restart, Stop and Start of either side keep it that way', async () => {
    expect((await h.api.run({ kind: 'restart', instanceId: docs.id })).op.state).toBe('succeeded');
    clean();
    expect((await h.api.run({ kind: 'stop', instanceId: docs.id })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'start', instanceId: docs.id })).op.state).toBe('succeeded');
    clean();
    expect((await h.api.run({ kind: 'stop', instanceId: shadow.id })).op.state).toBe('succeeded');
    expect((await h.api.run({ kind: 'start', instanceId: shadow.id })).op.state).toBe('succeeded');
    clean();
  });

  it('an existing link converges on the next Start of the consumer: same containers, same address', async () => {
    await legacy();
    const ids = [containerNamed(consumerDb).id, containerNamed(providerWeb).id];
    expect((await h.api.run({ kind: 'stop', instanceId: shadow.id })).op.state).toBe('succeeded');
    const { op } = await h.api.run({ kind: 'start', instanceId: shadow.id });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    clean();
    expect([containerNamed(consumerDb).id, containerNamed(providerWeb).id]).toEqual(ids);
    expect(h.fake.envOf(consumerDb)?.['DOCS_BASE_URL']).toBe('http://docs-link:3010');
    expect(op.events.map((e) => e.message).join('\n')).toMatch(/re-attached .*-web-1 to link network .* as docs-link only/);
  });

  it('an existing link converges on the next Restart of the provider too', async () => {
    await legacy();
    expect((await h.api.run({ kind: 'restart', instanceId: docs.id })).op.state).toBe('succeeded');
    clean();
  });

  it('an existing link converges on a configure of the consumer (relink to the same provider)', async () => {
    await legacy();
    const { op } = await h.api.run({ kind: 'configure', instanceId: shadow.id, links: { docs: { instanceId: docs.id } } });
    expect(op.state, JSON.stringify(op.error)).toBe('succeeded');
    clean();
  });
});
