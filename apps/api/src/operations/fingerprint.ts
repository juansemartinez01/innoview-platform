import { createHash } from 'node:crypto';

// v2 uses typed nodes, so undefined/absent/null and user objects cannot collide
// with serializer markers. No getters, toJSON, class instances or sparse arrays.
export function canonicalArguments(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(input: unknown): unknown {
    if (input === undefined) return ['undefined'];
    if (input === null) return ['null'];
    if (typeof input === 'string' || typeof input === 'boolean')
      return [typeof input, input];
    if (typeof input === 'number' && Number.isFinite(input))
      return ['number', Object.is(input, -0) ? '-0' : String(input)];
    if (typeof input !== 'object')
      throw new Error('Unsupported fingerprint value');
    if (ancestors.has(input)) throw new Error('Cyclic fingerprint value');
    ancestors.add(input);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(input);
      if (Reflect.ownKeys(input).some((key) => typeof key !== 'string'))
        throw new Error('Unsupported fingerprint key');
      if (Array.isArray(input)) {
        if (Object.keys(descriptors).length !== input.length + 1)
          throw new Error('Unsupported fingerprint array');
        const values: unknown[] = [];
        for (let index = 0; index < input.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
            throw new Error('Unsupported fingerprint array');
          values.push(encode(descriptor.value));
        }
        return ['array', values];
      }
      const prototype: unknown = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error('Unsupported fingerprint object');
      return [
        'object',
        Object.keys(descriptors)
          .sort()
          .map((key) => {
            const descriptor = descriptors[key];
            if (!descriptor.enumerable || !('value' in descriptor))
              throw new Error('Unsupported fingerprint property');
            return [key, encode(descriptor.value)];
          }),
      ];
    } finally {
      ancestors.delete(input);
    }
  }
  return JSON.stringify(encode(value));
}

export function operationFingerprint(
  version: number,
  type: string,
  args: Record<string, unknown>,
): string {
  let serialized: string;
  if (version === 1) {
    // Frozen historical algorithm: only the first argument level was sorted.
    serialized = JSON.stringify({
      version: 1,
      type,
      args: Object.fromEntries(
        Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    });
  } else if (version === 2)
    serialized = canonicalArguments({ version: 2, type, args });
  else throw new Error('Unsupported fingerprint version');
  return createHash('sha256').update(serialized).digest('hex');
}
