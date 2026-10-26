import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { apiEnvironment, localConfiguration } from './environment.mjs';

const [mode, ...extra] = process.argv.slice(2);
if (!['dev', 'start'].includes(mode) || extra.length) {
  console.error('Expected API dev/start without extra Node or Nest flags');
  process.exit(1);
}
try {
  const file = localConfiguration();
  const env = apiEnvironment(process.env, file);
  const excluded = [
    ...new Set([...Object.keys(file), ...Object.keys(process.env)]),
  ]
    .filter((key) => !(key.toUpperCase() in env))
    .sort();
  console.info(`API launcher excluded variables: ${JSON.stringify(excluded)}`);
  const root = fileURLToPath(new URL('../../apps/api/', import.meta.url));
  const args =
    mode === 'dev'
      ? [
          join(root, 'node_modules/@nestjs/cli/bin/nest.js'),
          'start',
          '--watch',
          '--no-shell',
          '--exec',
          process.execPath,
        ]
      : [join(root, 'dist/main.js')];
  // A new process is essential: deleting process.env in the HTTP server itself
  // would leave its original environment available through OS process inspection.
  // No shell, execArgv, NODE_OPTIONS or .env flag is forwarded to this child.
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let stopping = false;
  function stop(signal) {
    if (stopping || !child.pid) return;
    stopping = true;
    if (process.platform === 'win32') {
      spawnSync(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
    } else {
      try {
        process.kill(-child.pid, signal);
      } catch {
        /* already stopped */
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* stopped */
        }
      }, 5000).unref();
    }
  }
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  child.on('error', () => {
    console.error('API process could not start; sensitive details omitted');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
  });
} catch {
  console.error(
    'API launcher failed; verify local configuration. Values omitted.',
  );
  process.exitCode = 1;
}
