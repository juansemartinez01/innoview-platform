import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { provisionDatabase } from '../../apps/api/dist/persistence/provision.js';
import {
  createDataSource,
  initializeApplicationDataSource,
  initializeAuthorizationOperatorDataSource,
  initializeMembershipOperatorDataSource,
  initializeOrganizationsOperatorDataSource,
} from '../../apps/api/dist/persistence/data-sources.js';
const pg = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
)('pg');

export async function disposableAuthorization(operation) {
  if (
    !process.env.TEST_POSTGRES_PASSWORD ||
    !process.env.TEST_DB_HOST ||
    !process.env.TEST_DB_PORT
  )
    throw new Error('Disposable PostgreSQL TEST_* required');
  const suffix = randomUUID().replaceAll('-', '');
  const env = {
    DB_HOST: process.env.TEST_DB_HOST,
    DB_PORT: process.env.TEST_DB_PORT,
    DB_SSL: 'disable',
    DB_NAME: `innoview_test_${suffix}`,
    DB_BOOTSTRAP_USER: 'test_bootstrap',
    PLATFORM_POSTGRES_PASSWORD: process.env.TEST_POSTGRES_PASSWORD,
  };
  for (const purpose of [
    'app',
    'migrator',
    'portal',
    'control',
    'membership',
    'organizations',
    'authorization',
  ]) {
    env[`DB_${purpose.toUpperCase()}_USER`] = `bench_${purpose}_${suffix}`;
    env[`DB_${purpose.toUpperCase()}_PASSWORD`] =
      randomBytes(24).toString('hex');
  }
  const admin = new pg.Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    database: 'postgres',
    user: env.DB_BOOTSTRAP_USER,
    password: env.PLATFORM_POSTGRES_PASSWORD,
  });
  const sources = {};
  let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(env.DB_NAME)}`);
    created = true;
    await provisionDatabase(env);
    sources.migrator = createDataSource('migrator', env);
    await sources.migrator.initialize();
    await sources.migrator.runMigrations();
    await provisionDatabase(env);
    for (const [kind, initialize] of Object.entries({
      app: initializeApplicationDataSource,
      authorization: initializeAuthorizationOperatorDataSource,
      membership: initializeMembershipOperatorDataSource,
      organizations: initializeOrganizationsOperatorDataSource,
    }))
      sources[kind] = await initialize(env);
    return await operation({ env, sources });
  } finally {
    await Promise.allSettled(
      Object.values(sources)
        .filter((source) => source.isInitialized)
        .map((source) => source.destroy()),
    );
    try {
      if (created) {
        await admin.query(`DROP DATABASE ${pg.escapeIdentifier(env.DB_NAME)}`);
        for (const purpose of [
          'app',
          'migrator',
          'portal',
          'control',
          'membership',
          'organizations',
          'authorization',
        ])
          await admin.query(
            `DROP ROLE IF EXISTS ${pg.escapeIdentifier(env[`DB_${purpose.toUpperCase()}_USER`])}`,
          );
      }
    } finally {
      await admin.end();
    }
  }
}
