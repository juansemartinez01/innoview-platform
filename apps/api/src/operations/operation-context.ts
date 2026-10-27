import type { EntityManager } from 'typeorm';
import type { OrganizationOperation } from './trusted-operation.js';
import { canonicalUuid } from '../security/security-events.js';

export function technicalOperation(
  value: OrganizationOperation,
): OrganizationOperation {
  if (
    !value ||
    !['SYSTEM', 'INNOVIEW_OPERATOR'].includes(value.actorType) ||
    value.userIdentityId !== undefined ||
    typeof value.actor !== 'string' ||
    typeof value.reason !== 'string' ||
    !value.actor.trim() ||
    !value.reason.trim() ||
    value.actor.length > 200 ||
    value.reason.length > 500 ||
    /\p{Cc}/u.test(value.actor + value.reason) ||
    typeof value.requestId !== 'string' ||
    !canonicalUuid(value.requestId.toLowerCase())
  )
    throw new Error('Invalid trusted operation');
  return {
    ...value,
    actor: value.actor.trim(),
    reason: value.reason.trim(),
    requestId: value.requestId.toLowerCase(),
  };
}
// Role validation belongs to the caller; this helper never chooses credentials.
export async function establishOperationContext(
  manager: EntityManager,
  namespace: 'organizations' | 'authorization',
  value: OrganizationOperation,
  tenantId?: string,
) {
  if (!manager.queryRunner?.isTransactionActive)
    throw new Error('Active operation transaction required');
  const operation = technicalOperation(value);
  if (namespace === 'authorization' && !canonicalUuid(tenantId))
    throw new Error('Canonical tenant required');
  const prefix =
    namespace === 'organizations'
      ? 'innoview.organization_'
      : 'innoview.authorization_';
  for (const [key, data] of Object.entries({
    request: operation.requestId,
    actor: operation.actor,
    reason: operation.reason,
    actor_type: operation.actorType,
  }))
    await manager.query('SELECT set_config($1,$2,true)', [prefix + key, data]);
  if (tenantId)
    await manager.query("SELECT set_config('innoview.tenant_id',$1,true)", [
      tenantId,
    ]);
  await manager.query("SELECT set_config('lock_timeout','8s',true)");
  if (namespace === 'organizations' && tenantId)
    await manager.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('innoview:organization-write:'||$1,0))",
      [tenantId],
    );
}
export class TrustedOperationTransientError extends Error {
  readonly retryable = true;
  readonly retryAfterSeconds = 1;
  constructor(readonly code: string) {
    super('Trusted operation temporarily unavailable');
  }
}
export function transientFailure(error: unknown): string | null {
  // pg-pool acquisition timeout has no SQLSTATE/code. Match only its fixed
  // diagnostic, never log the message or treat arbitrary SQL errors as retryable.
  if (
    error instanceof Error &&
    error.name === 'Error' &&
    !('code' in error) &&
    [
      'timeout exceeded when trying to connect',
      'Connection terminated due to connection timeout',
    ].includes(error.message)
  )
    return 'POOL_ACQUISITION_TIMEOUT';
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  return typeof code === 'string' &&
    (code.startsWith('08') ||
      [
        '55P03',
        '40001',
        '40P01',
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        '57P01',
        '57P02',
        '57P03',
        '53300',
      ].includes(code))
    ? code
    : null;
}
