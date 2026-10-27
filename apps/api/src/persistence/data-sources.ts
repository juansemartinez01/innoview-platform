import { authorizationEntities } from '../authorization/entities.js';
import 'reflect-metadata';
import { Membership } from '../memberships/membership.entity.js';
import { MembershipAuditEvent } from '../memberships/audit-event.entity.js';
import { organizationEntities } from '../organizations/entities/index.js';
import { UserIdentity } from '../identity/user-identity.entity.js';
import { DataSource } from 'typeorm';
import { fileURLToPath } from 'node:url';
import { connectionConfig, type Environment } from './connection.config.js';

export function createDataSource(
  purpose:
    | 'app'
    | 'migrator'
    | 'membership'
    | 'organizations'
    | 'authorization'
    | 'authorization_delegation'
    | 'organizations_provisioner'
    | 'directory_maintenance',
  env: Environment = process.env,
): DataSource {
  const config = connectionConfig(purpose, env);
  return new DataSource({
    type: 'postgres',
    uuidExtension: 'pgcrypto',
    installExtensions: false,
    host: config.host,
    port: config.port,
    database: config.database,
    username: config.user,
    password: config.password,
    ssl: config.ssl,
    connectTimeoutMS: config.connectionTimeoutMillis,
    schema: ['authorization', 'authorization_delegation'].includes(purpose)
      ? 'authorization'
      : [
            'organizations',
            'organizations_provisioner',
            'directory_maintenance',
          ].includes(purpose)
        ? 'organizations'
        : purpose === 'membership'
          ? 'memberships'
          : purpose === 'app'
            ? 'foundation'
            : 'platform_meta',
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
    entities: [
      ...authorizationEntities,
      UserIdentity,
      ...organizationEntities,
      Membership,
      MembershipAuditEvent,
    ],
    logging: false,
    poolSize: 5,
  });
}

async function initializeRestrictedDataSource(
  purpose:
    | 'app'
    | 'membership'
    | 'organizations'
    | 'authorization'
    | 'authorization_delegation'
    | 'organizations_provisioner'
    | 'directory_maintenance',
  env: Environment = process.env,
): Promise<DataSource> {
  const source = createDataSource(purpose, env);
  try {
    await source.initialize();
    const [role] = await source.query<
      {
        unsafe: boolean;
      }[]
    >(
      `SELECT (
      r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
      OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid)
      OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = r.oid)
      OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r.oid)
      OR EXISTS (SELECT 1 FROM pg_database WHERE datdba = r.oid)
      OR shobj_description(r.oid,'pg_authid') IS DISTINCT FROM $1
      OR has_database_privilege(current_user, current_database(), 'CREATE')
      OR has_database_privilege(current_user, current_database(), 'TEMP')
      OR EXISTS (SELECT 1 FROM pg_namespace WHERE has_schema_privilege(current_user, oid, 'CREATE'))
    ) AS unsafe FROM pg_roles r WHERE rolname = current_user`,
      [`innoview:${String(source.options.database)}:${purpose}`],
    );
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

export function initializeApplicationDataSource(
  env: Environment = process.env,
): Promise<DataSource> {
  return initializeRestrictedDataSource('app', env);
}
export function initializeMembershipOperatorDataSource(
  env: Environment = process.env,
): Promise<DataSource> {
  return initializeRestrictedDataSource('membership', env);
}

export function initializeOrganizationsOperatorDataSource(
  env: Environment = process.env,
): Promise<DataSource> {
  return initializeRestrictedDataSource('organizations', env);
}

export function initializeAuthorizationOperatorDataSource(
  env: Environment = process.env,
): Promise<DataSource> {
  return initializeRestrictedDataSource('authorization', env);
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
      OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=r.oid AND nspname NOT IN ('foundation','platform_meta','portal_sessions','control_sessions','identity','organizations','memberships','authorization'))
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

export function initializeOrganizationsProvisionerDataSource(
  env: Environment = process.env,
) {
  return initializeRestrictedDataSource('organizations_provisioner', env);
}
export function initializeDirectoryMaintenanceDataSource(
  env: Environment = process.env,
) {
  return initializeRestrictedDataSource('directory_maintenance', env);
}

export function initializeAuthorizationDelegationDataSource(
  env: Environment = process.env,
) {
  return initializeRestrictedDataSource('authorization_delegation', env);
}
