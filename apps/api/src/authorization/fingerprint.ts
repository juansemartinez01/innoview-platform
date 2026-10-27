import { createHash } from 'node:crypto';
import { canonicalArgumentsV2 } from '../operations/fingerprint.js';

// Historical Authorization v2 envelope. Organizations v1/v2 are different
// contracts. Never reinterpret an existing record using the current version.
// If the serializer evolves, retain this typed-node v2 algorithm unchanged.
const serializeV2 = canonicalArgumentsV2;
export function authorizationFingerprint(
  version: number,
  operation: string,
  args: Record<string, unknown>,
): string {
  if (version !== 2)
    throw new Error('Unsupported Authorization fingerprint version');
  return createHash('sha256')
    .update(
      serializeV2({ module: 'authorization', version: 2, operation, args }),
    )
    .digest('hex');
}
