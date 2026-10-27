import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { backupDatabase } from './backup.mjs';
import { connectionConfig } from '../../apps/api/dist/persistence/connection.config.js';
try {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      directory: { type: 'string' },
      project: { type: 'string' },
      service: { type: 'string' },
    },
  });
  if (!values.directory) throw new Error('Explicit backup directory required');
  const source = connectionConfig('bootstrap');
  if (source.host !== '127.0.0.1')
    throw new Error(
      'Only the documented local development deployment is supported',
    );
  const project = values.project ?? 'innoview-platform-dev',
    service = values.service ?? 'postgres-platform';
  if (
    !/^(innoview-platform-(dev|test)|innoview-clean-[a-f0-9]{8})$/.test(
      project,
    ) ||
    !['postgres-platform', 'postgres-test'].includes(service)
  )
    throw new Error(
      'Only documented local fixtures/development selectors supported',
    );
  process.env.FOUNDATION_COMPOSE_PROJECT = project;
  process.env.FOUNDATION_POSTGRES_SERVICE = service;
  const directory = resolve(values.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result = await backupDatabase(process.env, directory);
  console.info(
    JSON.stringify({
      archive: result.archive,
      manifest: result.manifest,
      sha256: result.sha256,
    }),
  );
} catch {
  console.error(
    'Local development backup failed; verify isolated bootstrap configuration, container and destination. Details omitted.',
  );
  process.exitCode = 1;
}
