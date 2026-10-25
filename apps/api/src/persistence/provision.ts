import pg from 'pg';
import { connectionConfig, type Environment } from './connection.config.js';

// Controlled bootstrap operation. No credentials or query text are logged.
export async function provisionDatabase(
  env: Environment = process.env,
): Promise<void> {
  const bootstrap = connectionConfig('bootstrap', env);
  const app = connectionConfig('app', env);
  const migrator = connectionConfig('migrator', env);
  const portal = connectionConfig('portal', env);
  const control = connectionConfig('control', env);
  const configs = [bootstrap, app, migrator, portal, control];
  const runtime = [app, portal, control];
  const runtimeNames = runtime
    .map((c) => pg.escapeIdentifier(c.user))
    .join(', ');
  if (
    new Set(configs.map((c) => c.user)).size !== 5 ||
    new Set(configs.map((c) => c.password)).size !== 5
  ) {
    throw new Error(
      'Bootstrap, migrator and app must use independent credentials',
    );
  }
  const client = new pg.Client(bootstrap);
  const q = pg.escapeIdentifier;
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `innoview:provision:${bootstrap.database}`,
    ]);
    const admin = await client.query<{ rolsuper: boolean }>(
      'SELECT rolsuper FROM pg_roles WHERE rolname=current_user',
    );
    if (!admin.rows[0]?.rolsuper)
      throw new Error('Bootstrap administrator required');
    for (const [config, kind] of [
      [app, 'app'],
      [migrator, 'migrator'],
      [portal, 'portal'],
      [control, 'control'],
    ] as const) {
      const marker = `innoview:${bootstrap.database}:${kind}`;
      const existing = await client.query<{ marker: string | null }>(
        "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname=$1",
        [config.user],
      );
      if (existing.rowCount && existing.rows[0]?.marker !== marker) {
        throw new Error('Existing unmanaged role; refusing to modify it');
      }
      if (!existing.rowCount) {
        await client.query(`CREATE ROLE ${q(config.user)}`);
        await client.query(
          `COMMENT ON ROLE ${q(config.user)} IS ${pg.escapeLiteral(marker)}`,
        );
      }
      const memberships = await client.query(
        'SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)',
        [config.user],
      );
      if (memberships.rowCount)
        throw new Error('Unexpected role membership; refusing provisioning');
      await client.query(
        `ALTER ROLE ${q(config.user)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${pg.escapeLiteral(config.password)}`,
      );
      await client.query(
        `ALTER ROLE ${q(config.user)} IN DATABASE ${q(bootstrap.database)} SET search_path TO pg_catalog`,
      );
    }
    const owned = await client.query(
      'SELECT 1 FROM pg_class WHERE relowner IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1)) UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1)) UNION ALL SELECT 1 FROM pg_database WHERE datdba IN (SELECT oid FROM pg_roles WHERE rolname=ANY($1))',
      [runtime.map((c) => c.user)],
    );
    if (owned.rowCount)
      throw new Error('Application role must not own database objects');
    const databaseOwner = await client.query(
      'SELECT 1 FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname=$1)',
      [migrator.user],
    );
    if (databaseOwner.rowCount)
      throw new Error('Migrator must not own databases');
    const outsideSchemas = await client.query(
      "SELECT 1 FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname=$1) AND nspname NOT IN ('foundation','platform_meta','portal_sessions','control_sessions','identity')",
      [migrator.user],
    );
    if (outsideSchemas.rowCount)
      throw new Error('Migrator owns an unmanaged schema');
    await client.query(
      `REVOKE ALL ON DATABASE ${q(bootstrap.database)} FROM PUBLIC, ${runtimeNames}, ${q(migrator.user)}`,
    );
    await client.query(
      `GRANT CONNECT ON DATABASE ${q(bootstrap.database)} TO ${runtimeNames}, ${q(migrator.user)}`,
    );
    await client.query(
      `REVOKE ALL ON SCHEMA public FROM PUBLIC, ${runtimeNames}, ${q(migrator.user)}`,
    );
    for (const schema of [
      'foundation',
      'platform_meta',
      'portal_sessions',
      'control_sessions',
      'identity',
    ]) {
      const owner = await client.query<{ owner: string }>(
        'SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1',
        [schema],
      );
      if (owner.rowCount && owner.rows[0]?.owner !== migrator.user)
        throw new Error('Existing unmanaged schema; refusing to modify it');
      if (!owner.rowCount)
        await client.query(
          `CREATE SCHEMA ${q(schema)} AUTHORIZATION ${q(migrator.user)}`,
        );
      const foreignOwners = await client.query(
        'SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=$2)',
        [schema, migrator.user],
      );
      if (foreignOwners.rowCount)
        throw new Error('Unexpected table or sequence owner');
      await client.query(
        `REVOKE ALL ON SCHEMA ${q(schema)} FROM PUBLIC, ${runtimeNames}`,
      );
      await client.query(
        `REVOKE ALL ON ALL TABLES IN SCHEMA ${q(schema)} FROM PUBLIC, ${runtimeNames}`,
      );
      await client.query(
        `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${q(schema)} FROM PUBLIC, ${runtimeNames}`,
      );
      await client.query(
        `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${q(schema)} FROM PUBLIC, ${runtimeNames}`,
      );
      for (const objects of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(migrator.user)} IN SCHEMA ${q(schema)} REVOKE ALL ON ${objects} FROM PUBLIC, ${runtimeNames}`,
        );
      }
    }
    for (const objects of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(migrator.user)} REVOKE ALL ON ${objects} FROM PUBLIC, ${runtimeNames}`,
      );
    }
    for (const [schema, role] of [
      ['foundation', app.user],
      ['portal_sessions', portal.user],
      ['control_sessions', control.user],
    ]) {
      await client.query(`GRANT USAGE ON SCHEMA ${q(schema)} TO ${q(role)}`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${q(schema)} TO ${q(role)}`,
      );
      await client.query(
        `GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${q(schema)} TO ${q(role)}`,
      );
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(migrator.user)} IN SCHEMA ${q(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${q(role)}`,
      );
      await client.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(migrator.user)} IN SCHEMA ${q(schema)} GRANT USAGE ON SEQUENCES TO ${q(role)}`,
      );
    }
    // Identity is append/read-only at runtime; no mutation or broad grants to BFFs.
    await client.query(`GRANT USAGE ON SCHEMA identity TO ${q(app.user)}`);
    await client.query(
      `GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA identity TO ${q(app.user)}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${q(migrator.user)} IN SCHEMA identity GRANT SELECT, INSERT ON TABLES TO ${q(app.user)}`,
    );
    await client.query('COMMIT');
  } catch {
    // Never emit PostgreSQL errors: DDL errors may contain password literals.
    await client.query('ROLLBACK').catch(() => undefined);
    throw new Error(
      'Database provisioning failed; verify credentials, managed roles, memberships and schema ownership.',
    );
  } finally {
    await client.end();
  }
}
