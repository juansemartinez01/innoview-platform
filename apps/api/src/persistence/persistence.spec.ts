import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import pg from 'pg';
import { connectionConfig, type Environment } from './connection.config.js';
import {
  createDataSource,
  initializeApplicationDataSource,
  validateMigratorConnection,
} from './data-sources.js';
import { verifyMemberships } from '../memberships/memberships.spec.js';
import { verifyOrganizations } from '../organizations/organizations.spec.js';
import { provisionDatabase } from './provision.js';

function sqlState(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

await test('PostgreSQL real: provisioning, restricted roles and versioned migrations (not tenant isolation)', async (t) => {
  const password = process.env.TEST_POSTGRES_PASSWORD;
  const portText = process.env.TEST_DB_PORT;
  const host = process.env.TEST_DB_HOST;
  assert.ok(
    password && host && portText,
    'Start the disposable PostgreSQL and configure TEST_*; never substitute the development DB.',
  );
  assert.match(portText, /^\d+$/);
  const suffix = randomUUID().replaceAll('-', '');
  const database = `innoview_test_${suffix}`;
  const appRole = `test_app_${suffix}`;
  const migrationRole = `test_migrator_${suffix}`;
  const bootstrap = new pg.Client({
    host,
    port: Number(portText),
    database: 'postgres',
    user: 'test_bootstrap',
    password,
    connectionTimeoutMillis: 5000,
  });
  const env: Environment = {
    DB_HOST: host,
    DB_PORT: portText,
    DB_NAME: database,
    DB_SSL: 'disable',
    DB_BOOTSTRAP_USER: 'test_bootstrap',
    PLATFORM_POSTGRES_PASSWORD: password,
    DB_APP_USER: appRole,
    DB_APP_PASSWORD: randomBytes(24).toString('hex'),
    DB_MIGRATOR_USER: migrationRole,
    DB_PORTAL_USER: `test_portal_${suffix}`,
    DB_PORTAL_PASSWORD: randomBytes(24).toString('hex'),
    DB_CONTROL_USER: `test_control_${suffix}`,
    DB_CONTROL_PASSWORD: randomBytes(24).toString('hex'),
    DB_MEMBERSHIP_USER: `test_membership_${suffix}`,
    DB_MEMBERSHIP_PASSWORD: randomBytes(24).toString('hex'),
    DB_MIGRATOR_PASSWORD: randomBytes(24).toString('hex'),
  };
  const app = createDataSource('app', env);
  const migrator = createDataSource('migrator', env);
  let created = false;
  await bootstrap.connect();
  try {
    await bootstrap.query(`CREATE DATABASE ${pg.escapeIdentifier(database)}`);
    created = true;

    await t.test(
      'configuration fails without secrets in validation errors',
      () => {
        assert.throws(
          () =>
            connectionConfig('app', { ...env, DB_PORT: env.DB_APP_PASSWORD }),
          /Invalid DB_PORT/,
        );
        assert.throws(
          () => connectionConfig('app', { ...env, DB_APP_PASSWORD: undefined }),
          /DB_APP_PASSWORD/,
        );
        assert.throws(
          () => connectionConfig('app', { ...env, DB_SSL: 'insecure' }),
          /DB_SSL/,
        );
        assert.equal(app.options.synchronize, false);
        assert.equal(app.options.migrationsRun, false);
        assert.equal('dropSchema' in app.options, false);
      },
    );

    await t.test(
      'provisioning runs twice against an existing database without resetting data',
      async () => {
        await provisionDatabase(env);
        await provisionDatabase(env);
        await app.initialize();
        await migrator.initialize();
        const identity = await app.query<{ username: string }[]>(
          'SELECT current_user AS username',
        );
        assert.equal(identity[0]?.username, appRole);
      },
    );

    await t.test(
      'both restricted roles lack elevated flags, memberships and database ownership',
      async () => {
        const result = await bootstrap.query<{
          rolname: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolreplication: boolean;
          rolinherit: boolean;
        }>(
          'SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit FROM pg_roles WHERE rolname=ANY($1)',
          [[appRole, migrationRole]],
        );
        assert.equal(result.rows.length, 2);
        for (const role of result.rows) {
          for (const flag of [
            'rolsuper',
            'rolbypassrls',
            'rolcreatedb',
            'rolcreaterole',
            'rolreplication',
            'rolinherit',
          ] as const)
            assert.equal(role[flag], false, `${role.rolname}: ${flag}`);
        }
        const memberships = await bootstrap.query(
          'SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1))',
          [[appRole, migrationRole]],
        );
        assert.equal(memberships.rowCount, 0);
        const owners = await bootstrap.query(
          'SELECT 1 FROM pg_database WHERE datdba IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1))',
          [[appRole, migrationRole]],
        );
        assert.equal(owners.rowCount, 0);
      },
    );

    await t.test(
      'migrator applies the real migration and owns the technical table',
      async () => {
        assert.equal((await migrator.runMigrations()).length, 5);
        assert.equal(await migrator.showMigrations(), false);
        const [owner] = await migrator.query<{ owner: string }[]>(
          "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='foundation.persistence_probe'::regclass",
        );
        assert.equal(owner?.owner, migrationRole);
      },
    );

    await t.test(
      'application can CRUD with the identity sequence and cannot set its value',
      async () => {
        const [row] = await app.query<{ id: string }[]>(
          'INSERT INTO foundation.persistence_probe(value) VALUES ($1) RETURNING id',
          ['before-reprovision'],
        );
        assert.ok(row?.id);
        await app.query(
          'UPDATE foundation.persistence_probe SET value=$1 WHERE id=$2',
          ['updated', row.id],
        );
        const rows = await app.query<{ value: string }[]>(
          'SELECT value FROM foundation.persistence_probe WHERE id=$1',
          [row.id],
        );
        assert.equal(rows[0]?.value, 'updated');
        await app.query(
          'DELETE FROM foundation.persistence_probe WHERE id=$1',
          [row.id],
        );
        await app.query(
          'INSERT INTO foundation.persistence_probe(value) VALUES ($1)',
          ['retained'],
        );
        await assert.rejects(
          app.query(
            "SELECT setval('foundation.persistence_probe_id_seq', 100)",
          ),
          (error) => sqlState(error, '42501'),
        );
      },
    );

    await t.test(
      'UserIdentity has a real unique pair, PK/FK integrity and minimal schema privileges',
      async () => {
        const pair = [
          'https://identity.example.invalid/realms/test',
          'subject-one',
        ];
        const [first] = await app.query<
          { id: string; created_at: Date; updated_at: Date }[]
        >(
          'INSERT INTO identity.user_identity(issuer,external_subject) VALUES ($1,$2) RETURNING *',
          pair,
        );
        assert.match(first.id, /^[0-9a-f-]{36}$/);
        assert.equal(first.created_at.getTime(), first.updated_at.getTime());
        await assert.rejects(
          app.query(
            'INSERT INTO identity.user_identity(issuer,external_subject) VALUES ($1,$2)',
            pair,
          ),
          (error) => sqlState(error, '23505'),
        );
        await assert.rejects(
          app.query(
            "INSERT INTO identity.user_identity(issuer,external_subject) VALUES ('','x')",
          ),
          (error) => sqlState(error, '23514'),
        );
        await assert.rejects(
          app.query(
            "INSERT INTO identity.user_identity(issuer,external_subject) VALUES ('x',NULL)",
          ),
          (error) => sqlState(error, '23502'),
        );
        const different = await app.query<{ id: string }[]>(
          'INSERT INTO identity.user_identity(issuer,external_subject) VALUES ($1,$2),($3,$4) RETURNING id',
          [
            pair[0],
            'subject-two',
            'https://another.example.invalid/realms/test',
            pair[1],
          ],
        );
        assert.equal(
          new Set([first.id, ...different.map((row) => row.id)]).size,
          3,
        );
        for (const sql of [
          'UPDATE identity.user_identity SET issuer=issuer',
          'DELETE FROM identity.user_identity',
          'TRUNCATE identity.user_identity',
          'CREATE TABLE identity.forbidden(id int)',
          'SELECT * FROM platform_meta.migrations',
        ])
          await assert.rejects(app.query(sql), (error) =>
            sqlState(error, '42501'),
          );
        for (const kind of ['portal', 'control'] as const) {
          const client = new pg.Client(connectionConfig(kind, env));
          await client.connect();
          try {
            await assert.rejects(
              client.query('SELECT * FROM identity.user_identity'),
              (error) => sqlState(error, '42501'),
            );
          } finally {
            await client.end();
          }
        }
        // A technical FK fixture exists only in this disposable DB. No future
        // Membership/organization table is introduced by the production migration.
        await migrator.query(
          'CREATE TABLE identity.reference_probe(identity_id uuid REFERENCES identity.user_identity(id) ON DELETE RESTRICT)',
        );
        try {
          await migrator.query(
            'INSERT INTO identity.reference_probe VALUES ($1)',
            [first.id],
          );
          await assert.rejects(
            migrator.query('INSERT INTO identity.reference_probe VALUES ($1)', [
              randomUUID(),
            ]),
            (error) => sqlState(error, '23503'),
          );
          await assert.rejects(
            migrator.query('DELETE FROM identity.user_identity WHERE id=$1', [
              first.id,
            ]),
            (error) => sqlState(error, '23001'),
          );
          await assert.rejects(
            migrator.query('DROP TABLE identity.user_identity'),
            (error) => sqlState(error, '2BP01'),
          );
        } finally {
          await migrator.query('DROP TABLE identity.reference_probe');
        }
        await provisionDatabase(env);
        await assert.rejects(
          app.query('DELETE FROM identity.user_identity'),
          (error) => sqlState(error, '42501'),
        );
        const changes = await migrator.driver.createSchemaBuilder().log();
        assert.deepEqual(
          changes.upQueries.map((query) => query.query),
          [],
          'Entity metadata must match the versioned schema',
        );
      },
    );

    await t.test(
      'application cannot DDL, truncate, create temp tables, create roles or use migrator metadata',
      async () => {
        for (const sql of [
          'CREATE TABLE foundation.forbidden(id integer)',
          'CREATE TABLE public.forbidden(id integer)',
          'CREATE SCHEMA forbidden',
          'CREATE TEMP TABLE forbidden(id integer)',
          'ALTER TABLE foundation.persistence_probe ADD COLUMN forbidden integer',
          'DROP TABLE foundation.persistence_probe',
          'TRUNCATE foundation.persistence_probe',
          'CREATE ROLE forbidden',
          'SELECT * FROM platform_meta.migrations',
          'DELETE FROM platform_meta.migrations',
          `SET ROLE ${pg.escapeIdentifier(migrationRole)}`,
        ])
          await assert.rejects(
            app.query(sql),
            (error) => sqlState(error, '42501'),
            sql,
          );
      },
    );

    await t.test(
      'migrator cannot create databases, roles or objects outside its schemas',
      async () => {
        for (const sql of [
          'CREATE DATABASE forbidden',
          'CREATE ROLE forbidden',
          'CREATE TABLE public.forbidden(id integer)',
          'CREATE SCHEMA forbidden',
        ]) {
          await assert.rejects(
            migrator.query(sql),
            (error) => sqlState(error, '42501'),
            sql,
          );
        }
      },
    );

    await t.test(
      'default ACLs cover future tables/sequences and do not expose functions',
      async () => {
        await migrator.query(
          'CREATE TABLE foundation.future_probe(id bigint GENERATED ALWAYS AS IDENTITY, value text)',
        );
        await app.query(
          'INSERT INTO foundation.future_probe(value) VALUES ($1)',
          ['future'],
        );
        const rows = await app.query<{ value: string }[]>(
          'SELECT value FROM foundation.future_probe',
        );
        assert.equal(rows[0]?.value, 'future');
        await migrator.query(
          'CREATE TABLE platform_meta.private_probe(value text)',
        );
        await assert.rejects(
          app.query('SELECT * FROM platform_meta.private_probe'),
          (error) => sqlState(error, '42501'),
        );
        await migrator.query(
          'CREATE FUNCTION foundation.private_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
        );
        await assert.rejects(
          app.query('SELECT foundation.private_probe()'),
          (error) => sqlState(error, '42501'),
        );
        await migrator.query('DROP FUNCTION foundation.private_probe()');
        await migrator.query('DROP TABLE platform_meta.private_probe');
        await migrator.query('DROP TABLE foundation.future_probe');
      },
    );

    await t.test(
      'repeated provisioning preserves data and protects migration history',
      async () => {
        await provisionDatabase(env);
        const rows = await app.query<{ value: string }[]>(
          'SELECT value FROM foundation.persistence_probe',
        );
        assert.equal(rows[0]?.value, 'retained');
        await assert.rejects(
          app.query('SELECT * FROM platform_meta.migrations'),
          (error) => sqlState(error, '42501'),
        );
        assert.equal((await migrator.runMigrations()).length, 0);
      },
    );

    await t.test(
      'incorrect credentials are rejected; API startup accepts only a restricted role',
      async () => {
        const bad = createDataSource('app', {
          ...env,
          DB_APP_PASSWORD: randomBytes(24).toString('hex'),
        });
        await assert.rejects(bad.initialize(), (error) =>
          sqlState(error, '28P01'),
        );
        const safe = await initializeApplicationDataSource({
          ...env,
          PLATFORM_POSTGRES_PASSWORD: undefined,
          DB_BOOTSTRAP_USER: undefined,
          DB_MIGRATOR_USER: undefined,
          DB_MIGRATOR_PASSWORD: undefined,
        });
        await safe.destroy();
        await validateMigratorConnection({
          ...env,
          PLATFORM_POSTGRES_PASSWORD: undefined,
          DB_BOOTSTRAP_USER: undefined,
          DB_APP_USER: undefined,
          DB_APP_PASSWORD: undefined,
        });
        await assert.rejects(
          validateMigratorConnection({
            ...env,
            DB_MIGRATOR_USER: 'test_bootstrap',
            DB_MIGRATOR_PASSWORD: password,
          }),
          /role validation failed/,
        );
        await assert.rejects(
          initializeApplicationDataSource({
            ...env,
            DB_APP_USER: migrationRole,
            DB_APP_PASSWORD: env.DB_MIGRATOR_PASSWORD,
          }),
          /role validation failed/,
        );
      },
    );

    await verifyOrganizations(t, app, migrator, env);
    await verifyMemberships(t, app, migrator, env);

    await t.test(
      'real migration reverts and reapplies only in this disposable database',
      async () => {
        assert.match(database, /^innoview_test_[a-f0-9]{32}$/);
        const revertMemberships = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL('./migration.cli.js', import.meta.url)),
            'revert',
          ],
          {
            env: { ...process.env, ...env, DB_DISPOSABLE: 'true' },
            encoding: 'utf8',
            windowsHide: true,
          },
        );
        assert.equal(revertMemberships.status, 0, revertMemberships.stderr);
        await assert.rejects(
          app.query('SELECT * FROM memberships.membership'),
          (error) => sqlState(error, '42P01'),
        );
        const revertOrganizations = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL('./migration.cli.js', import.meta.url)),
            'revert',
          ],
          {
            env: { ...process.env, ...env, DB_DISPOSABLE: 'true' },
            encoding: 'utf8',
            windowsHide: true,
          },
        );
        assert.equal(revertOrganizations.status, 0, revertOrganizations.stderr);
        await assert.rejects(
          app.query('SELECT * FROM organizations.tenant'),
          (error) => sqlState(error, '42P01'),
        );
        const revert = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL('./migration.cli.js', import.meta.url)),
            'revert',
          ],
          {
            env: { ...process.env, ...env, DB_DISPOSABLE: 'true' },
            encoding: 'utf8',
            windowsHide: true,
          },
        );
        assert.equal(revert.status, 0, revert.stderr);
        await assert.rejects(
          app.query('SELECT * FROM identity.user_identity'),
          (error) => sqlState(error, '42P01'),
        );
        const revertSessions = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL('./migration.cli.js', import.meta.url)),
            'revert',
          ],
          {
            env: { ...process.env, ...env, DB_DISPOSABLE: 'true' },
            encoding: 'utf8',
            windowsHide: true,
          },
        );
        assert.equal(revertSessions.status, 0, revertSessions.stderr);
        const revertProbe = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL('./migration.cli.js', import.meta.url)),
            'revert',
          ],
          {
            env: { ...process.env, ...env, DB_DISPOSABLE: 'true' },
            encoding: 'utf8',
            windowsHide: true,
          },
        );
        assert.equal(revertProbe.status, 0, revertProbe.stderr);
        await assert.rejects(
          app.query('SELECT * FROM foundation.persistence_probe'),
          (error) => sqlState(error, '42P01'),
        );
        assert.equal(await migrator.showMigrations(), true);
        const reapply = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL('./migration.cli.js', import.meta.url)),
            'run',
          ],
          {
            env: { ...process.env, ...env, DB_DISPOSABLE: 'true' },
            encoding: 'utf8',
            windowsHide: true,
          },
        );
        assert.equal(reapply.status, 0, reapply.stderr);
        assert.equal((await migrator.runMigrations()).length, 0);
        await app.query(
          'INSERT INTO foundation.persistence_probe(value) VALUES ($1)',
          ['reapplied'],
        );
      },
    );
  } finally {
    if (app.isInitialized) await app.destroy();
    if (migrator.isInitialized) await migrator.destroy();
    try {
      if (created) {
        // Database name is generated by this test, never taken from DB_NAME.
        await bootstrap.query(`DROP DATABASE ${pg.escapeIdentifier(database)}`);
        for (const role of [
          env.DB_PORTAL_USER!,
          env.DB_CONTROL_USER!,
          env.DB_MEMBERSHIP_USER!,
        ])
          await bootstrap.query(
            `DROP ROLE IF EXISTS ${pg.escapeIdentifier(role)}`,
          );
        await bootstrap.query(
          `DROP ROLE IF EXISTS ${pg.escapeIdentifier(appRole)}`,
        );
        await bootstrap.query(
          `DROP ROLE IF EXISTS ${pg.escapeIdentifier(migrationRole)}`,
        );
      }
    } finally {
      await bootstrap.end();
    }
  }
});
