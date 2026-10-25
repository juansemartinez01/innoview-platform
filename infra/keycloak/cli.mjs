import { migrateLogout } from './migrate-logout.mjs';
import { configuration } from './contract.mjs';
import { administrator, inspectRealm, provisionRealm } from './admin.mjs';
import { verifyPublicEndpoints } from './verify.mjs';

try {
  const action = process.argv[2];
  if (!['provision', 'check', 'migrate-logout'].includes(action))
    throw new Error('Use oidc:provision, oidc:check or oidc:migrate:logout');
  const config = configuration();
  const request = await administrator(config);
  if (action === 'migrate-logout') await migrateLogout(request);
  else if (action === 'provision') await provisionRealm(request);
  else {
    const state = await inspectRealm(request);
    if (!state.exists || state.differences.length)
      throw new Error(
        `Missing realm or OIDC drift: ${state.differences.join(', ')}`,
      );
  }
  const result = await verifyPublicEndpoints(config);
  console.log(
    `OIDC contract verified: ${config.issuer}; ${result.signingKeys} RS256 signing key(s). No credentials emitted.`,
  );
} catch (error) {
  // Own errors contain field names/status only. Never emit token responses or config.
  console.error(
    error instanceof Error ? error.message : 'OIDC configuration failed',
  );
  process.exitCode = 1;
}
