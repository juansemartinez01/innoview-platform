import { parseArgs } from 'node:util';
import {
  initializeAuthorizationOperatorDataSource,
  initializeMembershipOperatorDataSource,
  initializeOrganizationsOperatorDataSource,
} from '../persistence/data-sources.js';
import { AuthorizationService } from './authorization.service.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import type { DataSource } from 'typeorm';

const sources: DataSource[] = [];
try {
  const [launcher, command, ...args] = process.argv.slice(2);
  if (launcher !== 'authorization-bootstrap')
    throw new Error('Explicit launcher required');
  const { values: v } = parseArgs({
    args,
    strict: true,
    options: Object.fromEntries(
      [
        'tenant',
        'membership',
        'role',
        'scope-type',
        'scope-unit',
        'actor',
        'reason',
        'request-id',
        'name',
        'description',
        'permission',
      ].map((k) => [k, { type: 'string' as const }]),
    ),
  });
  for (const key of ['tenant', 'actor', 'reason', 'request-id'])
    if (!v[key]) throw new Error('Explicit context required');
  const operation = {
    actor: v.actor!,
    actorType: 'INNOVIEW_OPERATOR' as const,
    reason: v.reason!,
    requestId: v['request-id']!,
  };
  const source = await initializeAuthorizationOperatorDataSource();
  sources.push(source);
  let service = new AuthorizationService(source);
  let result: unknown;
  if (command === 'create-role')
    result = await service.createRole(
      v.tenant!,
      v.name ?? '',
      v.description ?? '',
      operation,
    );
  else if (command === 'grant-permission')
    result = await service.grantPermission(
      v.tenant!,
      v.role ?? '',
      v.permission ?? '',
      operation,
    );
  else if (command === 'grant-admin') {
    const membership = await initializeMembershipOperatorDataSource();
    sources.push(membership);
    const organizations = await initializeOrganizationsOperatorDataSource();
    sources.push(organizations);
    const members = new MembershipsService(membership),
      orgs = new OrganizationsService(organizations);
    service = new AuthorizationService(source, {
      membershipActive: (t, m) => members.activeMembershipReference(t, m),
      scopeAvailable: (t, u, type) => orgs.availableScopeReference(t, u, type),
    });
    result = await service.assign(
      v.tenant!,
      v.membership ?? '',
      v.role ?? '',
      {
        type: v['scope-type'] as 'GROUP' | 'COMPANY' | 'BRANCH',
        unitId: v['scope-unit'] ?? '',
      },
      operation,
      'GRANT_TENANT_ADMIN',
    );
  } else throw new Error('Unknown explicit operation');
  console.log(JSON.stringify({ requestId: operation.requestId, result }));
} catch {
  console.error(
    'Authorization technical operation rejected; check explicit arguments and isolated credentials. Details omitted.',
  );
  process.exitCode = 1;
} finally {
  await Promise.allSettled(sources.map((s) => s.destroy()));
}
