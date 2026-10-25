import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { validateMigratorConnection } from './data-sources.js';

const supported = new Set(['run', 'show', 'create', 'generate', 'revert']);
const action = process.argv[2] ?? '';
const args = process.argv.slice(3);
if (
  !supported.has(action) ||
  args.some(
    (arg) =>
      arg === '-d' || arg.startsWith('-d=') || arg.startsWith('--dataSource'),
  )
) {
  console.error(
    'Use the documented migration commands and the configured migrator DataSource.',
  );
  process.exitCode = 1;
} else if (
  action === 'revert' &&
  (process.env.DB_DISPOSABLE !== 'true' ||
    !/^innoview_test_[a-f0-9]{32}$/.test(process.env.DB_NAME ?? ''))
) {
  console.error(
    'Revert is restricted to explicitly disposable test databases. Development data is preserved.',
  );
  process.exitCode = 1;
} else {
  try {
    if (action !== 'create' && !args.includes('--help') && !args.includes('-h'))
      await validateMigratorConnection();
    const require = createRequire(import.meta.url);
    const cli = join(dirname(require.resolve('typeorm')), 'cli.js');
    const source = join(import.meta.dirname, 'migration-data-source.js');
    const result = spawnSync(
      process.execPath,
      [
        cli,
        `migration:${action}`,
        ...args,
        ...(action === 'create' ? [] : ['-d', source]),
      ],
      { stdio: 'inherit', windowsHide: true },
    );
    process.exitCode = result.status ?? 1;
  } catch {
    console.error(
      'Migration connection or role validation failed. Credentials and queries are omitted.',
    );
    process.exitCode = 1;
  }
}
