import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type SecurityEvent =
  | 'AUTHENTICATION_REJECTED'
  | 'AUTHORIZATION_REJECTED'
  | 'SECURITY_CONTEXT_MISSING'
  | 'DATABASE_PRIVILEGE_REJECTED'
  | 'DATABASE_UNAVAILABLE'
  | 'DATABASE_OPERATION_FAILED'
  | 'TRUSTED_OPERATION_REJECTED'
  | 'TRUSTED_OPERATION_REPLAY'
  | 'TRUSTED_OPERATION_CONFLICT';
export const correlation = new AsyncLocalStorage<string>();
export const canonicalUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function correlationId(value: unknown): string {
  return canonicalUuid(value) ? value : randomUUID();
}
// Deliberately no arbitrary metadata, errors, principals, SQL or request objects.
export function securityEvent(event: SecurityEvent, requestId?: string): void {
  console.info(
    JSON.stringify({
      event,
      correlationId: correlation.getStore(),
      requestId: canonicalUuid(requestId) ? requestId : undefined,
    }),
  );
}
export function databaseFailure(error: unknown): SecurityEvent {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  if (code === '42501') return 'DATABASE_PRIVILEGE_REJECTED';
  if (
    typeof code === 'string' &&
    (code.startsWith('08') ||
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        '57P01',
        '57P02',
        '57P03',
        '53300',
      ].includes(code))
  )
    return 'DATABASE_UNAVAILABLE';
  return 'DATABASE_OPERATION_FAILED';
}
