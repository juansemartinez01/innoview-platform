import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, access, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'innoview-clean-'));
const project = `innoview-clean-${randomUUID().slice(0, 8)}`;
const freePort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return String(port);
};
const env = {};
for (const key of [
  'PATH',
  'Path',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramW6432',
  'ProgramFiles(x86)',
  'ProgramData',
  'ALLUSERSPROFILE',
  'CI',
  'PLAYWRIGHT_BROWSERS_PATH',
])
  if (process.env[key]) env[key] = process.env[key];
Object.assign(env, {
  TEST_DB_HOST: '127.0.0.1',
  TEST_DB_PORT: await freePort(),
  TEST_KEYCLOAK_PORT: await freePort(),
  FOUNDATION_COMPOSE_FILE: join(directory, 'compose.clean.yaml'),
  FOUNDATION_COMPOSE_PROJECT: project,
  NEXT_TELEMETRY_DISABLED: '1',
  TURBO_TELEMETRY_DISABLED: '1',
});
for (const key of [
  'TEST_POSTGRES_PASSWORD',
  'TEST_KEYCLOAK_ADMIN_PASSWORD',
  'TEST_IDENTITY_POSTGRES_PASSWORD',
])
  env[key] = process.env[key] ?? randomBytes(24).toString('hex');
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      env,
      shell: command === 'pnpm' && process.platform === 'win32',
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', () =>
      reject(new Error('Clean-install command unavailable')),
    );
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error('Clean-install verification failed')),
    );
  });
const compose = ['compose', '-f', 'compose.clean.yaml', '-p', project];
let infrastructure = false;
try {
  // Copy only versionable files into a new tree: no .env, node_modules, build
  // outputs, databases or volumes. Includes the current reviewable worktree so
  // local pre-commit verification tests precisely the changes being reviewed.
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  for (const file of new Set(files)) {
    if (file.startsWith('.env') && file !== '.env.example')
      throw new Error('Secret env file in versionable source inventory');
    const target = resolve(directory, file);
    if (
      !target.startsWith(
        resolve(directory) + (process.platform === 'win32' ? '\\' : '/'),
      )
    )
      throw new Error('Unsafe source inventory path');
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, file), target);
  }
  await assertAbsent(join(directory, '.env'));
  console.info(
    'Clean install: fresh source tree; no env file or inherited operational credentials.',
  );
  await run('pnpm', ['install', '--frozen-lockfile']);
  infrastructure = true;
  await run('docker', [
    ...compose,
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '240',
  ]);
  await run('pnpm', ['build']);
  await run('pnpm', ['test']);
  console.info(
    'Clean install verified: roles/migrations/OIDC/API/BFF/HTTP/context/RBAC/diagnostics/recovery.',
  );
} finally {
  if (infrastructure)
    await run('docker', [...compose, 'down']).catch(() => {
      process.exitCode = 1;
      console.error('Clean-install resource cleanup requires inspection');
    });
  const target = resolve(directory);
  if (!target.startsWith(join(resolve(tmpdir()), 'innoview-clean-'))) {
    process.exitCode = 1;
    console.error('Unsafe cleanup target refused');
  } else await rm(target, { recursive: true, force: true });
}
async function assertAbsent(path) {
  try {
    await access(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Clean tree unexpectedly contains local env');
}
