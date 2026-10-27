// Controlled PostgreSQL tools. Callers choose generated disposable databases
// for restore drills; passwords are passed via environment, never CLI arguments.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

export async function postgresContainer() {
  const project =
      process.env.FOUNDATION_COMPOSE_PROJECT ?? 'innoview-platform-test',
    service = process.env.FOUNDATION_POSTGRES_SERVICE ?? 'postgres-test';
  if (!/^[a-z0-9_-]+$/.test(project) || !/^[a-z0-9_-]+$/.test(service))
    throw new Error('Invalid backup container selector');
  // Labels avoid resolving Compose files and inheriting unrelated IdP secrets
  // just to identify a PostgreSQL container.
  const container = (
    await command('docker', [
      'ps',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--filter',
      `label=com.docker.compose.service=${service}`,
      '--format',
      '{{.ID}}',
    ])
  ).trim();
  if (!/^[a-f0-9]{12,64}$/.test(container))
    throw new Error('Expected exactly one running PostgreSQL container');
  return container;
}
export async function command(executable, args, { env = {}, input } = {}) {
  const system = {};
  for (const key of [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
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
    'SystemDrive',
  ])
    if (process.env[key]) system[key] = process.env[key];
  const child = spawn(executable, args, {
    env: { ...system, ...env },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  let diagnostic = '';
  child.stderr.on('data', (chunk) => {
    diagnostic += chunk.toString();
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('PostgreSQL tool unavailable')));
    child.once('exit', (code) => {
      if (code === 0) return resolve();
      const stage =
        ['pg_dump', 'pg_restore', 'cp', 'compose', 'sh'].find((value) =>
          args.includes(value),
        ) ?? 'tool';
      const category = /password authentication failed/i.test(diagnostic)
        ? 'AUTHENTICATION'
        : /permission denied/i.test(diagnostic)
          ? 'PRIVILEGE'
          : /no such|not found|does not exist/i.test(diagnostic)
            ? 'MISSING_RESOURCE'
            : /connect/i.test(diagnostic)
              ? 'CONNECTION'
              : 'OTHER';
      reject(
        new Error(
          `PostgreSQL tool failed: ${stage}/${category}; details omitted`,
        ),
      );
    });
  });
  return Buffer.concat(chunks).toString('utf8');
}
export async function backupDatabase(env, directory) {
  const container = await postgresContainer();
  if (!container)
    throw new Error('Disposable PostgreSQL container not available');
  const name = `innoview-${randomUUID()}.dump`,
    remote = `/tmp/${name}`,
    archive = join(directory, name);
  const secret = { PGPASSWORD: env.PLATFORM_POSTGRES_PASSWORD };
  try {
    await command(
      'docker',
      [
        'exec',
        '-e',
        'PGPASSWORD',
        container,
        'pg_dump',
        '--host=127.0.0.1',
        `--username=${env.DB_BOOTSTRAP_USER}`,
        `--dbname=${env.DB_NAME}`,
        '--format=custom',
        '--no-owner',
        '--no-acl',
        `--file=${remote}`,
      ],
      { env: secret },
    );
    await command('docker', ['cp', `${container}:${remote}`, archive]);
    const bytes = await readFile(archive),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifest = {
      version: 1,
      postgresMajor: 18,
      database: env.DB_NAME,
      host: env.DB_HOST,
      port: Number(env.DB_PORT),
      archive: basename(archive),
      sha256,
      createdAt: new Date().toISOString(),
    };
    const path = archive + '.json';
    await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o600,
    });
    return { archive, manifest: path, sha256 };
  } finally {
    await command('docker', [
      'exec',
      container,
      'rm',
      '-f',
      '--',
      remote,
    ]).catch(() => {});
  }
}
export async function restoreArchive(backup, target) {
  if (!/^innoview_test_[a-f0-9]{32}$/.test(target.DB_NAME))
    throw new Error('Restore drill requires generated disposable target');
  const container = await postgresContainer(),
    name = `innoview-${randomUUID()}`,
    remote = `/tmp/${name}.dump`,
    list = `/tmp/${name}.list`;
  const secret = { PGPASSWORD: target.PLATFORM_POSTGRES_PASSWORD };
  try {
    await command('docker', ['cp', backup.archive, `${container}:${remote}`]);
    const toc = await command('docker', [
      'exec',
      container,
      'pg_restore',
      '--list',
      remote,
    ]);
    // provisionDatabase owns the eight empty schemas already. All table data,
    // functions, constraints, triggers, sequences, metadata and policies remain.
    const selected = toc
      .split('\n')
      .filter((line) => !/^\d+; \d+ \d+ SCHEMA - /.test(line))
      .join('\n');
    await command(
      'docker',
      ['exec', '-i', container, 'sh', '-c', 'cat > "$1"', 'restore-list', list],
      { input: selected },
    );
    await command(
      'docker',
      [
        'exec',
        '-e',
        'PGPASSWORD',
        container,
        'pg_restore',
        '--host=127.0.0.1',
        `--username=${target.DB_BOOTSTRAP_USER}`,
        `--dbname=${target.DB_NAME}`,
        `--role=${target.DB_MIGRATOR_USER}`,
        '--no-owner',
        '--no-acl',
        '--single-transaction',
        '--exit-on-error',
        `--use-list=${list}`,
        remote,
      ],
      { env: secret },
    );
  } finally {
    await command('docker', [
      'exec',
      container,
      'rm',
      '-f',
      '--',
      remote,
      list,
    ]).catch(() => {});
  }
}
