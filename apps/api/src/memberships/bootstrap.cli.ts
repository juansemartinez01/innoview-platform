import { parseArgs } from 'node:util';
import { hostname, userInfo } from 'node:os';
import { initializeMembershipOperatorDataSource } from '../persistence/data-sources.js';
import { MembershipsService } from './memberships.service.js';

// Host operator possessing the dedicated credential; never a public endpoint.
// No administrative, migrator, Keycloak or business-role credential is needed.
try {
  const { values } = parseArgs({
    options: {
      'tenant-id': { type: 'string' },
      'user-identity-id': { type: 'string' },
      'request-id': { type: 'string' },
      reason: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (
    !values['tenant-id'] ||
    !values['user-identity-id'] ||
    !values['request-id'] ||
    !values.reason
  )
    throw new Error('Explicit target and audit context required');
  const source = await initializeMembershipOperatorDataSource();
  try {
    const result = await new MembershipsService(source).bootstrapFirst(
      values['tenant-id'],
      values['user-identity-id'],
      {
        actor: `host:${hostname()}/user:${userInfo().username}`,
        reason: values.reason,
        requestId: values['request-id'],
      },
    );
    console.info(
      JSON.stringify({
        membershipId: result.membership.id,
        tenantId: result.membership.tenantId,
        userIdentityId: result.membership.userIdentityId,
        status: result.membership.status,
        changed: result.changed,
        auditEventId: result.auditEventId,
      }),
    );
  } finally {
    await source.destroy();
  }
} catch {
  console.error(
    'Membership bootstrap rejected; verify explicit UUIDs, audit context, managed operator credentials and tenant membership history.',
  );
  process.exitCode = 1;
}
