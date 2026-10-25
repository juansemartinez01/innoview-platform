import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { fileURLToPath } from 'node:url';
import { connectionConfig, type Environment } from './connection.config.js';

export function createDataSource(
  purpose: 'app' | 'migrator',
  env: Environment = process.env,
): DataSource {
  const config = connectionConfig(purpose, env);
  return new DataSource({
    type: 'postgres',
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: config.password,
    ssl: config.ssl,
    connectTimeoutMS: config.connectionTimeoutMillis,
    schema: purpose === 'app' ? 'foundation' : 'platform_meta',
    synchronize: false,
    migrationsRun: false,
    migrationsTransactionMode: 'all',
    migrationsTableName: 'migrations',
    migrations:
      purpose === 'migrator'
        ? [
            fileURLToPath(
              new URL('./migrations/*.js', import.meta.url),
            ).replaceAll('\\', '/'),
          ]
        : [],
    entities: [],
    logging: false,
    poolSize: 5,
  });
}

export async function initializeApplicationDataSource(
  env: Environment = process.env,
): Promise<DataSource> {
  const source = createDataSource('app', env);
  try {
    await source.initialize();
    const [role] = await source.query<
      {
        unsafe: boolean;
      }[]
    >(`SELECT (
      r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
      OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = r.oid)
      OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r.oid)
      OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = r.oid)
      OR has_database_privilege(current_user, current_database(), 'CREATE')
      OR has_database_privilege(current_user, current_database(), 'TEMP')
      OR EXISTS (SELECT 1 FROM pg_namespace WHERE has_schema_privilege(current_user, oid, 'CREATE'))
    ) AS unsafe FROM pg_roles r WHERE rolname = current_user`);
    if (!role || role.unsafe)
      throw new Error('Unsafe application database role');
    return source;
  } catch {
    if (source.isInitialized) await source.destroy();
    throw new Error(
      'Application database connection or role validation failed; check configuration and provisioning.',
    );
  }
}

export async function validateMigratorConnection(
  env: Environment = process.env,
): Promise<void> {
  const source = createDataSource('migrator', env);
  try {
    await source.initialize();
    const [role] = await source.query<{ unsafe: boolean }[]>(`SELECT (
      r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
      OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = r.oid)
      OR has_database_privilege(current_user, current_database(), 'CREATE')
      OR has_database_privilege(current_user, current_database(), 'TEMP')
      OR (SELECT count(*) FROM pg_namespace WHERE nspname IN ('foundation','platform_meta') AND nspowner=r.oid) <> 2
      OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=r.oid AND nspname NOT IN ('foundation','platform_meta'))
    ) AS unsafe FROM pg_roles r WHERE rolname = current_user`);
    if (!role || role.unsafe) throw new Error('Unsafe migration role');
  } catch {
    throw new Error(
      'Migration connection or role validation failed; check provisioning.',
    );
  } finally {
    if (source.isInitialized) await source.destroy();
  }
}
