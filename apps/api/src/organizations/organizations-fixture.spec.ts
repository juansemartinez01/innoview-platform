import type { DataSource, EntityManager } from 'typeorm';
import type { Environment } from '../persistence/connection.config.js';
import {
  initializeOrganizationsProvisionerDataSource,
  initializeDirectoryMaintenanceDataSource,
} from '../persistence/data-sources.js';
import { OrganizationsService } from './organizations.service.js';

// Integration fixture only: two real, independent restricted credentials.
// The owning fixture already destroys source before dropping its generated DB;
// attach the second pool to that same explicit lifetime, including error paths.
const provisioners = new WeakMap<DataSource, DataSource>();
export async function organizationsProvisionerFixture(
  source: DataSource,
  env: Environment,
) {
  await organizationsFixture(source, env);
  return provisioners.get(source)!;
}
const diagnostics = new WeakMap<DataSource, DataSource>();
export function organizationReadFixture<T>(
  source: DataSource,
  tenant: string,
  action: (manager: EntityManager) => Promise<T>,
) {
  return source.transaction(async (manager) => {
    await manager.query("SELECT set_config('innoview.tenant_id',$1,true)", [
      tenant,
    ]);
    return action(manager);
  });
}
export async function organizationsDiagnosticFixture(
  source: DataSource,
  env: Environment,
) {
  let diagnostic = diagnostics.get(source);
  if (!diagnostic) {
    diagnostic = await initializeDirectoryMaintenanceDataSource(env);
    diagnostics.set(source, diagnostic);
    const destroy = source.destroy.bind(source),
      dependent = diagnostic;
    source.destroy = async () => {
      try {
        if (dependent.isInitialized) await dependent.destroy();
      } finally {
        await destroy();
      }
    };
  }
  return diagnostic;
}
export async function organizationsFixture(
  source: DataSource,
  env: Environment,
) {
  let provisioner = provisioners.get(source);
  if (!provisioner) {
    provisioner = await initializeOrganizationsProvisionerDataSource(env);
    provisioners.set(source, provisioner);
    const destroy = source.destroy.bind(source),
      dependent = provisioner;
    source.destroy = async () => {
      try {
        if (dependent.isInitialized) await dependent.destroy();
      } finally {
        await destroy();
      }
    };
  }
  return new OrganizationsService(source, provisioner);
}
