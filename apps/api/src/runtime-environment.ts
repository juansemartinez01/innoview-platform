import policy from './runtime-environment.policy.json' with { type: 'json' };

export class ApiRuntimeEnvironmentError extends Error {}

// Runs before importing NestJS/AppModule, including a direct compiled launch.
// This guard detects deployment mistakes; the launcher creates the clean OS
// environment. Neither mechanism is a sandbox against a trusted host operator.
export function assertApiRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const allowed = new Set(policy.configuration);
  const forbidden = Object.keys(env).filter((name) => {
    const key = name.toUpperCase();
    if (allowed.has(key)) return key !== name;
    return (
      policy.forbiddenPrefixes.some((prefix) => key.startsWith(prefix)) ||
      ['NODE_OPTIONS', 'NODE_PATH', 'NPM_CONFIG_NODE_OPTIONS'].includes(key) ||
      /(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|ACCESS_KEY|COOKIE_KEY)$/.test(key)
    );
  });
  if (forbidden.length) {
    // Report names only, never values or connection objects.
    throw new ApiRuntimeEnvironmentError(
      `Forbidden API runtime variables: ${forbidden.sort().join(', ')}`,
    );
  }
}
