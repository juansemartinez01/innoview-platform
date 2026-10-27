import {
  organizationsProvisionerFixture,
  organizationReadFixture,
  organizationsFixture,
  organizationsDiagnosticFixture,
} from './organizations-fixture.spec.js';
import { organizationOperation } from '../operations/fixtures.spec.js';
import { initializeOrganizationsOperatorDataSource } from '../persistence/data-sources.js';
import type { EntityManager } from 'typeorm';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import pg from 'pg';
import type { DataSource } from 'typeorm';
import {
  connectionConfig,
  type Environment,
} from '../persistence/connection.config.js';
import { provisionDatabase } from '../persistence/provision.js';
import {
  OrganizationsService,
  OrganizationOperationError,
} from './organizations.service.js';

function state(error: unknown, ...codes: string[]) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  );
}

// Called only from the Foundation fixture: generated disposable database and
// roles, never DB_NAME from the local environment. Not an RLS/access-control test.
export async function verifyOrganizations(
  t: TestContext,
  app: DataSource,
  migrator: DataSource,
  env: Environment,
) {
  const operator = await initializeOrganizationsOperatorDataSource(env);
  const service = await organizationsFixture(operator, env);
  const diagnostic = await organizationsDiagnosticFixture(operator, env);
  const pretenant = await organizationsProvisionerFixture(operator, env);
  let integrityTenant = '';
  const transaction = <T>(
    operation: (manager: EntityManager) => Promise<T>,
    tenantId = integrityTenant,
    provision = false,
  ) =>
    (provision ? pretenant : operator).transaction(async (manager) => {
      await manager.query("SELECT set_config('innoview.tenant_id',$1,true)", [
        tenantId,
      ]);
      const request = randomUUID();
      await manager.query(
        "SELECT set_config('innoview.organization_actor','fixture:integrity',true),set_config('innoview.organization_request',$1,true),set_config('innoview.organization_reason','Integrity fixture',true),set_config('innoview.organization_actor_type','SYSTEM',true)",
        [request],
      );
      await manager.query(
        "INSERT INTO organizations.operation(request_id,tenant_id,operation_type,fingerprint,actor,actor_type,reason,technical_source) VALUES($1,$2,$4,$3,'fixture:integrity','SYSTEM','Integrity fixture','isolated fixture')",
        [
          request,
          provision ? null : tenantId,
          '0'.repeat(64),
          provision ? 'CREATE_TENANT' : 'CREATE_COMPANY',
        ],
      );
      const result = await operation(manager);
      await manager.query(
        "UPDATE organizations.operation SET tenant_id=$2,result='{}',completed_at=clock_timestamp() WHERE request_id=$1",
        [request, tenantId],
      );
      return result;
    });
  const query = <T = unknown>(
    sql: string,
    parameters?: unknown[],
  ): Promise<T> =>
    sql.startsWith('SELECT')
      ? diagnostic.query<T>(sql, parameters)
      : sql.startsWith('INSERT INTO organizations.tenant')
        ? (() => {
            const id = parameters?.[0] ?? randomUUID();
            assert.ok(typeof id === 'string');
            const statement = parameters?.length
              ? sql
              : sql
                  .replace('tenant(name)', 'tenant(id,name)')
                  .replace(
                    "VALUES ('Missing group')",
                    "VALUES ($1,'Missing group')",
                  );
            return transaction(
              (manager) =>
                manager.query<T>(
                  statement,
                  parameters?.length ? parameters : [id],
                ),
              id,
              true,
            );
          })()
        : transaction((manager) => manager.query<T>(sql, parameters));
  try {
    const a = await service.createTenant(
      'Fixture A',
      'Group A',
      organizationOperation(),
    );
    integrityTenant = a.tenant.id;
    const b = await service.createTenant(
      'Fixture B',
      'Group B',
      organizationOperation(),
    );
    const ac = await service.createCompany(
      a.tenant.id,
      a.group.id,
      'Company A',
      'TEST-A',
      organizationOperation(),
    );
    const bc = await service.createCompany(
      b.tenant.id,
      b.group.id,
      'Company B',
      undefined,
      organizationOperation(),
    );
    const ab = await service.createBranch(
      a.tenant.id,
      ac.company.id,
      'Branch A',
      organizationOperation(),
    );

    await t.test(
      'Organizations: two independent complete tenants and derived hierarchy with one status owner',
      async () => {
        const first = await organizationReadFixture(
          operator,
          a.tenant.id,
          (manager) => service.getStructure(a.tenant.id, manager),
        );
        const second = await organizationReadFixture(
          operator,
          b.tenant.id,
          (manager) => service.getStructure(b.tenant.id, manager),
        );
        assert.equal(first.group.id, a.unit.id);
        assert.deepEqual(first.units.map((u) => u.type).sort(), [
          'BRANCH',
          'COMPANY',
          'GROUP',
        ]);
        assert.equal(
          first.units.find((u) => u.id === ac.company.id)?.parentId,
          a.group.id,
        );
        assert.equal(
          first.units.find((u) => u.id === ab.branch.id)?.parentId,
          ac.company.id,
        );
        assert.equal(
          first.units.find((u) => u.type === 'GROUP')?.parentId,
          null,
        );
        assert.equal(second.companies.length, 1);
        assert.equal(second.branches.length, 0);
        assert.ok(first.units.every((u) => u.tenantId === a.tenant.id));
        assert.ok(second.units.every((u) => u.tenantId === b.tenant.id));
        assert.equal(
          new Set([...first.units, ...second.units].map((u) => u.id)).size,
          5,
        );
        const columns = await migrator.query<{ column_name: string }[]>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='organizations' AND table_name='company'",
        );
        assert.ok(
          !columns.some((c) =>
            ['name', 'status', 'parent_id'].includes(c.column_name),
          ),
        );
      },
    );

    await t.test(
      'Organizations: unique group, IDs and typed correspondence are real PostgreSQL constraints',
      async () => {
        await assert.rejects(
          query('INSERT INTO organizations.tenant(id,name) VALUES ($1,$2)', [
            a.tenant.id,
            'Duplicate ID',
          ]),
          (error) => state(error, '23505'),
        );
        await assert.rejects(
          transaction(
            async (manager) => {
              const id = randomUUID();
              await manager.query(
                "INSERT INTO organizations.organizational_unit(id,tenant_id,type,name) VALUES ($1,$2,'GROUP','Second')",
                [id, a.tenant.id],
              );
              await manager.query(
                'INSERT INTO organizations.business_group(tenant_id,id) VALUES ($1,$2)',
                [a.tenant.id, id],
              );
            },
            a.tenant.id,
            true,
          ),
          (error) => state(error, '23505'),
        );
        await assert.rejects(
          query(
            'INSERT INTO organizations.company(tenant_id,id,business_group_id) VALUES ($1,$2,$3)',
            [a.tenant.id, ac.company.id, a.group.id],
          ),
          (error) => state(error, '23505'),
        );
        await assert.rejects(
          query(
            'INSERT INTO organizations.branch(tenant_id,id,company_id) VALUES ($1,$2,$3)',
            [a.tenant.id, a.group.id, ac.company.id],
          ),
          (error) => state(error, '23503'),
        );
        await assert.rejects(
          query(
            "INSERT INTO organizations.company(tenant_id,id,unit_type,business_group_id) VALUES ($1,$2,'BRANCH',$3)",
            [a.tenant.id, randomUUID(), a.group.id],
          ),
          (error) => state(error, '428C9'),
        );
      },
    );

    await t.test(
      'Organizations: composite FKs reject cross-tenant parents and units, including SQL bypassing services',
      async () => {
        for (const kind of ['COMPANY', 'BRANCH'] as const) {
          await assert.rejects(
            transaction(async (manager) => {
              const id = randomUUID();
              await manager.query(
                'INSERT INTO organizations.organizational_unit(id,tenant_id,type,name) VALUES ($1,$2,$3,$4)',
                [id, a.tenant.id, kind, 'Wrong parent'],
              );
              if (kind === 'COMPANY')
                await manager.query(
                  'INSERT INTO organizations.company(tenant_id,id,business_group_id) VALUES ($1,$2,$3)',
                  [a.tenant.id, id, b.group.id],
                );
              else
                await manager.query(
                  'INSERT INTO organizations.branch(tenant_id,id,company_id) VALUES ($1,$2,$3)',
                  [a.tenant.id, id, bc.company.id],
                );
            }),
            (error) => state(error, '23503'),
          );
        }
        await assert.rejects(
          query(
            'INSERT INTO organizations.branch(tenant_id,id,company_id) VALUES ($1,$2,$3)',
            [b.tenant.id, ab.branch.id, bc.company.id],
          ),
          (error) => state(error, '23514', '42501'),
        );
        await assert.rejects(
          service.createCompany(
            a.tenant.id,
            b.group.id,
            'Wrong',
            undefined,
            organizationOperation(),
          ),
          OrganizationOperationError,
        );
        await assert.rejects(
          service.createBranch(
            a.tenant.id,
            bc.company.id,
            'Wrong',
            organizationOperation(),
          ),
          OrganizationOperationError,
        );
      },
    );

    await t.test(
      'Organizations: invalid levels, self cycles, missing parents and orphan units cannot commit',
      async () => {
        for (const [kind, parent] of [
          ['COMPANY', ac.company.id],
          ['COMPANY', 'self'],
          ['BRANCH', a.group.id],
          ['BRANCH', 'self'],
        ] as const) {
          await assert.rejects(
            transaction(async (manager) => {
              const id = randomUUID();
              await manager.query(
                'INSERT INTO organizations.organizational_unit(id,tenant_id,type,name) VALUES ($1,$2,$3,$4)',
                [id, a.tenant.id, kind, 'Invalid level'],
              );
              const target = parent === 'self' ? id : parent;
              await manager.query(
                `INSERT INTO organizations.${kind === 'COMPANY' ? 'company' : 'branch'}(tenant_id,id,${kind === 'COMPANY' ? 'business_group_id' : 'company_id'}) VALUES ($1,$2,$3)`,
                [a.tenant.id, id, target],
              );
            }),
            (error) => state(error, '23503'),
          );
        }
        await assert.rejects(
          query(
            "INSERT INTO organizations.organizational_unit(tenant_id,type,name) VALUES ($1,'COMPANY','Orphan')",
            [a.tenant.id],
          ),
          (error) => state(error, '23514'),
        );
        await assert.rejects(
          query(
            "INSERT INTO organizations.tenant(name) VALUES ('Missing group')",
          ),
          (error) => state(error, '23514'),
        );
        await assert.rejects(
          query(
            'INSERT INTO organizations.branch(tenant_id,id,company_id) VALUES ($1,$2,$3)',
            [a.tenant.id, randomUUID(), randomUUID()],
          ),
          (error) => state(error, '23503'),
        );
        await assert.rejects(
          query(
            "INSERT INTO organizations.organizational_unit(tenant_id,type,name) VALUES ($1,'INVALID','Wrong')",
            [a.tenant.id],
          ),
          (error) => state(error, '23514'),
        );
      },
    );

    await t.test(
      'Organizations: failures and deferred completeness violations roll back every related write',
      async () => {
        const before = await query<{ count: number }[]>(
          'SELECT count(*)::int AS count FROM organizations.tenant',
        );
        await assert.rejects(
          service.createTenant(
            'Rollback tenant',
            '   ',
            organizationOperation(),
          ),
          OrganizationOperationError,
        );
        assert.deepEqual(
          await query(
            'SELECT count(*)::int AS count FROM organizations.tenant',
          ),
          before,
        );
        const unitId = randomUUID();
        const tenantId = randomUUID();
        await assert.rejects(
          transaction(
            async (manager) => {
              await manager.query(
                "INSERT INTO organizations.tenant(id,name) VALUES ($1,'Incomplete')",
                [tenantId],
              );
              await manager.query(
                "INSERT INTO organizations.organizational_unit(id,tenant_id,type,name) VALUES ($1,$2,'GROUP','Incomplete')",
                [unitId, tenantId],
              );
              // No typed group: statement succeeds, deferred constraint fails at commit.
            },
            tenantId,
            true,
          ),
          (error) => state(error, '23514'),
        );
        assert.equal(
          (
            await query<{ count: number }[]>(
              'SELECT count(*)::int AS count FROM organizations.tenant WHERE id=$1',
              [tenantId],
            )
          )[0].count,
          0,
        );
        assert.equal(
          (
            await query<{ count: number }[]>(
              'SELECT count(*)::int AS count FROM organizations.organizational_unit WHERE id=$1',
              [unitId],
            )
          )[0].count,
          0,
        );
      },
    );

    await t.test(
      'Organizations: concurrent writers commit complete siblings without losing correspondence',
      async () => {
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            service.createCompany(
              a.tenant.id,
              a.group.id,
              `Concurrent ${i}`,
              undefined,
              organizationOperation(),
            ),
          ),
        );
        assert.equal(new Set(results.map((r) => r.company.id)).size, 6);
        const structure = await organizationReadFixture(
          operator,
          a.tenant.id,
          (manager) => service.getStructure(a.tenant.id, manager),
        );
        assert.equal(structure.companies.length, 7);
        assert.equal(
          structure.units.filter((u) => u.type === 'COMPANY').length,
          7,
        );
      },
    );

    await t.test(
      'Organizations: lifecycle transitions, active ancestors and terminal archival are enforced by DB',
      async () => {
        const lifecycle = await service.createTenant(
          'State fixture',
          'State group',
          organizationOperation(),
        );
        integrityTenant = lifecycle.tenant.id;
        const company = await service.createCompany(
          lifecycle.tenant.id,
          lifecycle.group.id,
          'State company',
          undefined,
          organizationOperation(),
        );
        const branch = await service.createBranch(
          lifecycle.tenant.id,
          company.company.id,
          'State branch',
          organizationOperation(),
        );
        await service.setStatus(
          lifecycle.tenant.id,
          company.company.id,
          'INACTIVE',
          organizationOperation(),
        );
        await assert.rejects(
          service.createBranch(
            lifecycle.tenant.id,
            company.company.id,
            'Rejected',
            organizationOperation(),
          ),
          OrganizationOperationError,
        );
        const structure = await organizationReadFixture(
          operator,
          lifecycle.tenant.id,
          (manager) => service.getStructure(lifecycle.tenant.id, manager),
        );
        assert.equal(
          structure.units.find((u) => u.id === branch.branch.id)?.status,
          'ACTIVE',
        ); // own state, not inherited authority
        await service.setStatus(
          lifecycle.tenant.id,
          branch.branch.id,
          'INACTIVE',
          organizationOperation(),
        );
        await assert.rejects(
          service.setStatus(
            lifecycle.tenant.id,
            branch.branch.id,
            'ACTIVE',
            organizationOperation(),
          ),
          OrganizationOperationError,
        );
        await service.setStatus(
          lifecycle.tenant.id,
          company.company.id,
          'ACTIVE',
          organizationOperation(),
        );
        await service.setStatus(
          lifecycle.tenant.id,
          branch.branch.id,
          'ACTIVE',
          organizationOperation(),
        );
        await service.setStatus(
          lifecycle.tenant.id,
          null,
          'INACTIVE',
          organizationOperation(),
        );
        await assert.rejects(
          service.createCompany(
            lifecycle.tenant.id,
            lifecycle.group.id,
            'Rejected',
            undefined,
            organizationOperation(),
          ),
          OrganizationOperationError,
        );
        await service.setStatus(
          lifecycle.tenant.id,
          null,
          'ACTIVE',
          organizationOperation(),
        );
        await service.setStatus(
          lifecycle.tenant.id,
          company.company.id,
          'ARCHIVED',
          organizationOperation(),
        );
        await assert.rejects(
          service.setStatus(
            lifecycle.tenant.id,
            company.company.id,
            'ACTIVE',
            organizationOperation(),
          ),
          OrganizationOperationError,
        );
        await assert.rejects(
          query(
            "UPDATE organizations.organizational_unit SET status='ACTIVE' WHERE id=$1",
            [company.company.id],
          ),
          (error) => state(error, '23514'),
        );
        await assert.rejects(
          query(
            "UPDATE organizations.tenant SET status='UNKNOWN' WHERE id=$1",
            [lifecycle.tenant.id],
          ),
          (error) => state(error, '23514'),
        );
        const archived = await service.setStatus(
          lifecycle.tenant.id,
          null,
          'ARCHIVED',
          organizationOperation(),
        );
        const repeated = await service.setStatus(
          lifecycle.tenant.id,
          null,
          'ARCHIVED',
          organizationOperation(),
        );
        assert.equal(
          repeated.updatedAt.getTime(),
          archived.updatedAt.getTime(),
        );
        await assert.rejects(
          service.setStatus(
            lifecycle.tenant.id,
            null,
            'INACTIVE',
            organizationOperation(),
          ),
          OrganizationOperationError,
        );
      },
    );

    await t.test(
      'Organizations: RESTRICT and completeness protect deletion even for the migrator',
      async () => {
        for (const sql of [
          'DELETE FROM organizations.tenant WHERE id=$1',
          'DELETE FROM organizations.organizational_unit WHERE tenant_id=$1',
          'DELETE FROM organizations.business_group WHERE tenant_id=$1',
          'DELETE FROM organizations.company WHERE tenant_id=$1',
          'DELETE FROM organizations.branch WHERE tenant_id=$1',
          'UPDATE organizations.company SET business_group_id=id WHERE tenant_id=$1',
        ])
          await assert.rejects(operator.query(sql, [a.tenant.id]), (error) =>
            state(error, '42501'),
          );
        // FORCE RLS denies owner's DML too; the owner remains a trusted DDL actor.
        assert.deepEqual(
          await migrator.query('SELECT id FROM organizations.tenant'),
          [],
        );
      },
    );

    await t.test(
      'Organizations: restricted runtime ACLs survive repeated provisioning; BFFs cannot read structures',
      async () => {
        const [role] = await app.query<{ name: string }[]>(
          'SELECT current_user AS name',
        );
        await migrator.query(
          `GRANT UPDATE(name) ON organizations.tenant TO ${pg.escapeIdentifier(role.name)}`,
        );
        assert.equal(
          (
            await app.query<{ granted: boolean }[]>(
              "SELECT has_column_privilege(current_user,'organizations.tenant','name','UPDATE') AS granted",
            )
          )[0].granted,
          true,
        );
        await provisionDatabase(env);
        assert.equal(
          (
            await app.query<{ granted: boolean }[]>(
              "SELECT has_column_privilege(current_user,'organizations.tenant','name','UPDATE') AS granted",
            )
          )[0].granted,
          false,
        );
        for (const sql of [
          'DELETE FROM organizations.branch',
          'TRUNCATE organizations.tenant',
          'CREATE TABLE organizations.forbidden(id int)',
          "UPDATE organizations.tenant SET name='forbidden'",
          'SELECT * FROM platform_meta.migrations',
          'ALTER TABLE organizations.tenant DISABLE TRIGGER ALL',
        ])
          await assert.rejects(app.query(sql), (error) =>
            state(error, '42501'),
          );
        for (const purpose of ['portal', 'control'] as const) {
          const client = new pg.Client(connectionConfig(purpose, env));
          await client.connect();
          try {
            await assert.rejects(
              client.query('SELECT * FROM organizations.tenant'),
              (error) => state(error, '42501'),
            );
          } finally {
            await client.end();
          }
        }
        const flags = await app.query<
          {
            rolsuper: boolean;
            rolbypassrls: boolean;
          }[]
        >(
          'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
        );
        assert.equal(flags[0].rolsuper, false);
        assert.equal(flags[0].rolbypassrls, false);
        assert.equal(
          (
            await app.query<{ count: number }[]>(
              'SELECT count(*)::int AS count FROM organizations.tenant',
            )
          )[0].count,
          0,
        );
        await assert.rejects(
          new OrganizationsService(app).createTenant(
            'Forbidden',
            'Forbidden',
            organizationOperation(),
          ),
          OrganizationOperationError,
        );
        const changes = await migrator.driver.createSchemaBuilder().log();
        assert.deepEqual(
          changes.upQueries.map((q) => q.query),
          [],
          'Entity metadata must match the migration',
        );
        assert.equal((await migrator.runMigrations()).length, 0);
      },
    );
  } finally {
    await operator.destroy();
  }
}
