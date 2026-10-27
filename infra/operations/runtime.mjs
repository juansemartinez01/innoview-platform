import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { technicalEnvironment } from './environment.mjs';
import { fileURLToPath } from 'node:url';
const [purpose, ...args] = process.argv.slice(2);
if (
  ![
    'provision-tenant',
    'directory',
    'backup',
    'diagnose',
    'authorization-bootstrap',
  ].includes(purpose)
)
  throw new Error('Unknown technical operation');
const file = await readFile(new URL('../../.env', import.meta.url), 'utf8')
  .then(parseEnv)
  .catch((error) => {
    if (error.code === 'ENOENT') return {};
    throw error;
  });
const input = { ...file, ...process.env };
const env = technicalEnvironment(purpose, input);
const child = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL(
        purpose === 'authorization-bootstrap'
          ? '../../apps/api/dist/authorization/bootstrap.cli.js'
          : purpose === 'backup'
            ? './backup.cli.mjs'
            : purpose === 'diagnose'
              ? '../../apps/api/dist/persistence/diagnostics.cli.js'
              : '../../apps/api/dist/organizations/operations.cli.js',
        import.meta.url,
      ),
    ),
    purpose,
    ...args,
  ],
  { env, stdio: 'inherit', shell: false, windowsHide: true },
);
child.on('error', () => {
  console.error('Technical operation could not start');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
