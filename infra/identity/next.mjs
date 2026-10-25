// Load local configuration without --env-file in execArgv: Next forwards Node
// flags to workers through NODE_OPTIONS, which rejects that flag on Node 24.
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const [app, mode] = process.argv.slice(2);
if (
  !['portal', 'control-center'].includes(app) ||
  !['dev', 'start'].includes(mode)
)
  throw new Error('Expected a frontend and dev/start');
try {
  loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(
      'Unable to load local environment; sensitive details omitted',
    );
    process.exit(1);
  }
}

for (const suffix of ['COOKIE_PASSWORD', 'TOKEN_PASSWORD']) {
  if (
    process.env[`PORTAL_${suffix}`] &&
    process.env[`PORTAL_${suffix}`] === process.env[`CONTROL_${suffix}`]
  )
    throw new Error('Application keys must be independent');
}
const prefix = app === 'portal' ? 'PORTAL' : 'CONTROL';
for (const key of Object.keys(process.env)) {
  if (
    /^(KEYCLOAK_|TEST_|PLATFORM_|IDENTITY_)/.test(key) ||
    (/^DB_/.test(key) &&
      ![
        'DB_HOST',
        'DB_PORT',
        'DB_NAME',
        'DB_SSL',
        `DB_${prefix}_USER`,
        `DB_${prefix}_PASSWORD`,
      ].includes(key)) ||
    (/^(PORTAL_|CONTROL_)/.test(key) && !key.startsWith(`${prefix}_`))
  )
    delete process.env[key];
}
const cli = new URL(
  `../../apps/${app}/node_modules/next/dist/bin/next`,
  import.meta.url,
);
process.argv = [
  process.execPath,
  fileURLToPath(cli),
  mode,
  '--hostname',
  '127.0.0.1',
  '--port',
  app === 'portal' ? '3000' : '3001',
];
await import(cli.href);
