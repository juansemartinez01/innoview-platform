import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { DataSource } from 'typeorm';
import type { Environment } from '../persistence/connection.config.js';
import {
  initializeOrganizationsOperatorDataSource,
  initializeOrganizationsProvisionerDataSource,
} from '../persistence/data-sources.js';
import { OrganizationsService } from './organizations.service.js';
import { organizationOperation } from '../operations/fixtures.spec.js';
import { establishOperationContext } from '../operations/operation-context.js';
import pg from 'pg';
import { securityInvariants } from '../persistence/security-diagnostics.js';

export async function verifyOperationalBoundaries(
  t: TestContext,
  migrator: DataSource,
  env: Environment,
) {
  const ordinary = await initializeOrganizationsOperatorDataSource(env),
    pretenant = await initializeOrganizationsProvisionerDataSource(env);
  try {
    const service = new OrganizationsService(ordinary, pretenant),
      a = await service.createTenant(
        'Boundary A',
        'Group A',
        organizationOperation(),
      ),
      b = await service.createTenant(
        'Boundary B',
        'Group B',
        organizationOperation(),
      );
    await service.createCompany(
      a.tenant.id,
      a.group.id,
      'Company A',
      null,
      organizationOperation(),
    );
    await service.createCompany(
      b.tenant.id,
      b.group.id,
      'Company B',
      null,
      organizationOperation(),
    );
    await t.test(
      '[PostgreSQL] Ordinary Organizations SQL cannot read, insert or update tenant B with fixed tenant A; joins omit filters',
      async () => {
        await ordinary.transaction(async (manager) => {
          await manager.query(
            "SELECT set_config('innoview.tenant_id',$1,true)",
            [a.tenant.id],
          );
          assert.deepEqual(
            await manager.query(
              'SELECT id FROM organizations.tenant ORDER BY id',
            ),
            [{ id: a.tenant.id }],
          );
          const joined = await manager.query<{ tenant_id: string }[]>(
            'SELECT c.tenant_id FROM organizations.company c JOIN organizations.organizational_unit u ON u.id=c.id JOIN organizations.tenant t ON t.id=c.tenant_id',
          );
          assert.equal(joined.length, 1);
          assert.equal(joined[0].tenant_id, a.tenant.id);
          const [changed] = await manager.query<[{ id: string }[], number]>(
            "UPDATE organizations.tenant SET status='INACTIVE' WHERE id=$1 RETURNING id",
            [b.tenant.id],
          );
          assert.deepEqual(changed, []);
        });
        const op = organizationOperation();
        await assert.rejects(
          ordinary.transaction(async (manager) => {
            await establishOperationContext(
              manager,
              'organizations',
              op,
              a.tenant.id,
            );
            await manager.query(
              "INSERT INTO organizations.operation(request_id,tenant_id,operation_type,fingerprint,actor,actor_type,reason,technical_source) VALUES($1,$2,'CREATE_COMPANY',$3,$4,$5,$6,'fixture:boundary')",
              [
                op.requestId,
                b.tenant.id,
                '0'.repeat(64),
                op.actor,
                op.actorType,
                op.reason,
              ],
            );
          }),
          (error) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '42501',
        );
        assert.deepEqual(
          await ordinary.query('SELECT id FROM organizations.tenant'),
          [],
        );
      },
    );
    await t.test(
      '[PostgreSQL] Organizations restrictive boundary survives an additional permissive policy; noncanonical GUC fails closed',
      async () => {
        await migrator.query(
          `CREATE POLICY fixture_accidental_select ON organizations.tenant FOR SELECT TO ${pg.escapeIdentifier(env.DB_ORGANIZATIONS_USER!)} USING(true)`,
        );
        try {
          for (const value of [
            '',
            randomUUID(),
            'not-uuid',
            a.tenant.id.toUpperCase(),
            ' ' + a.tenant.id,
            '{' + a.tenant.id + '}',
          ])
            await ordinary.transaction(async (manager) => {
              await manager.query(
                "SELECT set_config('innoview.tenant_id',$1,true)",
                [value],
              );
              assert.deepEqual(
                await manager.query('SELECT id FROM organizations.tenant'),
                [],
              );
            });
        } finally {
          await migrator.query(
            'DROP POLICY fixture_accidental_select ON organizations.tenant',
          );
        }
      },
    );
    await t.test(
      '[Trusted service] Ordinary credential cannot provision a tenant; pretenant credential cannot create a company or change states',
      async () => {
        await assert.rejects(
          new OrganizationsService(ordinary).createTenant(
            'Forbidden',
            'Forbidden',
            organizationOperation(),
          ),
        );
        const provisioner = new OrganizationsService(pretenant);
        await assert.rejects(
          provisioner.createCompany(
            a.tenant.id,
            a.group.id,
            'Forbidden',
            null,
            organizationOperation(),
          ),
        );
        await assert.rejects(
          provisioner.setStatus(
            a.tenant.id,
            null,
            'INACTIVE',
            organizationOperation(),
          ),
        );
        const [flags] = await pretenant.query<{ unsafe: boolean }[]>(
          'SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole AS unsafe FROM pg_roles WHERE rolname=current_user',
        );
        assert.equal(flags.unsafe, false);
      },
    );
    await t.test(
      '[PostgreSQL] Global diagnostics detect unexpected maintenance/provisioner privileges and repair policy drift',
      async () => {
        assert.deepEqual((await securityInvariants(ordinary)).findings, []);
        await migrator.query(
          `GRANT MAINTAIN ON organizations.tenant TO ${pg.escapeIdentifier(env.DB_APP_USER!)}`,
        );
        try {
          assert.ok(
            (await securityInvariants(ordinary)).findings.includes(
              'TABLE_ACL:app:organizations.tenant',
            ),
          );
        } finally {
          await migrator.query(
            `REVOKE MAINTAIN ON organizations.tenant FROM ${pg.escapeIdentifier(env.DB_APP_USER!)}`,
          );
        }
        await migrator.query(
          `GRANT INSERT ON organizations.company TO ${pg.escapeIdentifier(env.DB_ORGANIZATIONS_PROVISIONER_USER!)}`,
        );
        try {
          assert.ok(
            (await securityInvariants(ordinary)).findings.some((value) =>
              value.startsWith(
                'COLUMN_ACL:organizations_provisioner:organizations.company:',
              ),
            ),
          );
        } finally {
          await migrator.query(
            `REVOKE INSERT ON organizations.company FROM ${pg.escapeIdentifier(env.DB_ORGANIZATIONS_PROVISIONER_USER!)}`,
          );
        }
        const [old] = await migrator.query<{ with_check: string }[]>(
          "SELECT with_check FROM pg_policies WHERE schemaname='organizations' AND tablename='tenant_directory' AND policyname='maintenance_insert_boundary'",
        );
        await migrator.query(
          'ALTER POLICY maintenance_insert_boundary ON organizations.tenant_directory WITH CHECK(true)',
        );
        try {
          assert.ok(
            (await securityInvariants(ordinary)).findings.includes(
              'REPAIR_WRITE_BOUNDARY:insert',
            ),
          );
        } finally {
          await migrator.query(
            `ALTER POLICY maintenance_insert_boundary ON organizations.tenant_directory WITH CHECK(${old.with_check})`,
          );
        }
        assert.deepEqual((await securityInvariants(ordinary)).findings, []);
      },
    );
  } finally {
    await pretenant.destroy();
    await ordinary.destroy();
  }
}
