import { parseArgs } from 'node:util';
import {
  initializeOrganizationsProvisionerDataSource,
  initializeDirectoryMaintenanceDataSource,
} from '../persistence/data-sources.js';
import { directoryDifferences } from '../persistence/security-diagnostics.js';
import { OrganizationsService } from './organizations.service.js';
import { repairDirectory } from './directory-repair.js';
try {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      name: { type: 'string' },
      group: { type: 'string' },
      tenant: { type: 'string' },
      actor: { type: 'string' },
      reason: { type: 'string' },
      'request-id': { type: 'string' },
      backup: { type: 'string' },
      'confirm-repair': { type: 'boolean' },
    },
  });
  const operation = {
    actor: values.actor ?? '',
    reason: values.reason ?? '',
    requestId: values['request-id'] ?? '',
    actorType: 'INNOVIEW_OPERATOR' as const,
  };
  if (command === 'provision-tenant') {
    const source = await initializeOrganizationsProvisionerDataSource();
    try {
      const result = await new OrganizationsService(source).createTenant(
        values.name ?? '',
        values.group ?? '',
        operation,
      );
      console.log(
        JSON.stringify({
          tenantId: result.tenant.id,
          requestId: operation.requestId,
        }),
      );
    } finally {
      await source.destroy();
    }
  } else if (command === 'directory') {
    const source = await initializeDirectoryMaintenanceDataSource();
    try {
      if (values['confirm-repair']) {
        if (!values.backup || !values.tenant)
          throw new Error('Repair needs backup and tenant');
        console.log(
          JSON.stringify(
            await repairDirectory(
              source,
              values.tenant,
              operation,
              values.backup,
            ),
          ),
        );
      } else {
        if (
          values.backup ||
          values.actor ||
          values.reason ||
          values['request-id']
        )
          throw new Error('Repair confirmation missing');
        const differences = await source.transaction(
          'REPEATABLE READ',
          async (manager) => {
            await manager.query('SET TRANSACTION READ ONLY');
            return directoryDifferences(manager);
          },
        );
        console.log(
          JSON.stringify({
            differences: differences.filter(
              (row) => !values.tenant || row.tenant_id === values.tenant,
            ),
          }),
        );
      }
    } finally {
      await source.destroy();
    }
  } else throw new Error('Unknown technical operation');
} catch {
  console.error(
    'Technical operation rejected; verify explicit arguments, isolated credentials, backup and diagnostics. Details omitted.',
  );
  process.exitCode = 1;
}
