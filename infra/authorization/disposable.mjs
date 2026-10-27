import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { provisionDatabase } from '../../apps/api/dist/persistence/provision.js';
import {
  createDataSource,
  initializeApplicationDataSource,
  initializeAuthorizationOperatorDataSource,
  initializeMembershipOperatorDataSource,
  initializeOrganizationsOperatorDataSource,
  initializeOrganizationsProvisionerDataSource,
  initializeDirectoryMaintenanceDataSource,
} from '../../apps/api/dist/persistence/data-sources.js';
const pg = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
)('pg');

export async function disposableAuthorization(
  operation,
  { schema11 = false, empty = false } = {},
) {
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
    'organizations_provisioner',
    'directory_maintenance',
  ]) {
    env[`DB_${purpose.toUpperCase()}_USER`] =
      `bench_${purpose.slice(0, 18)}_${suffix}`;
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
    const allMigrations = sources.migrator.migrations;
    if (schema11)
      sources.migrator.migrations = allMigrations.filter(
        (m) =>
          Number((m.name ?? m.constructor.name).slice(-13)) <= 1793037600000,
      );
    if (!empty) await sources.migrator.runMigrations();
    sources.migrator.migrations = allMigrations;
    await provisionDatabase(env);
    for (const [kind, initialize] of Object.entries({
      app: initializeApplicationDataSource,
      authorization: initializeAuthorizationOperatorDataSource,
      membership: initializeMembershipOperatorDataSource,
      organizations: initializeOrganizationsOperatorDataSource,
      provisioner: initializeOrganizationsProvisionerDataSource,
      maintenance: initializeDirectoryMaintenanceDataSource,
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
          'organizations_provisioner',
          'directory_maintenance',
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
