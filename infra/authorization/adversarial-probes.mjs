import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { disposableAuthorization } from './disposable.mjs';
import {
  IdentityReadTransactions,
  IdentityService,
} from '../../apps/api/dist/identity/identity.module.js';
import { OrganizationsService } from '../../apps/api/dist/organizations/organizations.service.js';
import { HttpSecurityErrors } from '../../apps/api/dist/security/http-security.js';

const phase = process.argv[2];
assert.ok(['before', 'after'].includes(phase));
const results = [];
await disposableAuthorization(async ({ sources }) => {
  const op = () => ({
    actor: 'fixture:adversarial',
    actorType: 'SYSTEM',
    reason: 'Discardable baseline probe',
    requestId: randomUUID(),
  });
  const organizations = new OrganizationsService(
    sources.organizations,
    sources.provisioner,
  );
  const a = await organizations.createTenant('Adversarial A', 'Group A', op());
  const b = await organizations.createTenant('Adversarial B', 'Group B', op());
  const literal = {
    issuer: 'https://unverified.invalid',
    subject: randomUUID(),
    clientId: 'innoview-portal',
  };
  await new IdentityService(sources.app).resolve(literal);
  const admitted = await new IdentityReadTransactions(
    sources.app,
    new IdentityService(sources.app),
  ).read(literal, async () => true);
  results.push({
    case: 'Literal Principal provenance',
    layer: 'trusted service',
    secure: admitted === null,
  });
  const other = await sources.organizations.transaction(async (manager) => {
    await manager.query("SELECT set_config('innoview.tenant_id',$1,true)", [
      a.tenant.id,
    ]);
    return manager.query('SELECT id FROM organizations.tenant WHERE id=$1', [
      b.tenant.id,
    ]);
  });
  results.push({
    case: 'Organizations SQL cross-tenant read with fixed GUC',
    layer: 'PostgreSQL RLS',
    secure: other.length === 0,
  });
});
let status, retry;
const response = {
  status(value) {
    status = value;
    return this;
  },
  json() {},
  setHeader(name, value) {
    if (name === 'Retry-After') retry = value;
  },
};
new HttpSecurityErrors().catch(new TypeError('Synthetic internal fault'), {
  switchToHttp: () => ({ getResponse: () => response }),
});
results.push({
  case: 'Internal bug is not retryable database outage',
  layer: 'HTTP error contract',
  secure: status === 500 && retry === undefined,
});
await mkdir('infra/authorization/evidence', { recursive: true });
await writeFile(
  `infra/authorization/evidence/probes-${phase}.json`,
  JSON.stringify({ phase, results }, null, 2) + '\n',
);
console.info(JSON.stringify({ phase, results }));
if (phase === 'after') assert.ok(results.every((result) => result.secure));
