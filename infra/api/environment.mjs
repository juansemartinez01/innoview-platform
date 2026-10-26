import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import policy from '../../apps/api/src/runtime-environment.policy.json' with { type: 'json' };

export function apiEnvironment(inherited, file = {}) {
  const result = {};
  // OS variables come only from the parent, never from the project's .env.
  // Canonicalize Windows names: PATH and Path must not coexist in spawn.env.
  for (const [name, value] of Object.entries(inherited)) {
    const key = name.toUpperCase();
    if (policy.system.includes(key) && value !== undefined) result[key] = value;
  }
  for (const key of policy.configuration) {
    const value = inherited[key] ?? file[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function localConfiguration() {
  try {
    // Parse without loading privileged values into process.env or Node options.
    return parseEnv(
      readFileSync(new URL('../../.env', import.meta.url), 'utf8'),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return {};
  }
  // Deliberately discard fs/parser diagnostics; these may reveal file contents.
  throw new Error('Unable to read local configuration; values omitted');
}
