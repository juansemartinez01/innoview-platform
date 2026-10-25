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
  const service = new OrganizationsService(app);
  const a = await service.createTenant('Fixture A', 'Group A');
  const b = await service.createTenant('Fixture B', 'Group B');
  const ac = await service.createCompany(
    a.tenant.id,
    a.group.id,
    'Company A',
    'TEST-A',
  );
  const bc = await service.createCompany(b.tenant.id, b.group.id, 'Company B');
  const ab = await service.createBranch(a.tenant.id, ac.company.id, 'Branch A');

  await t.test(
    'Organizations: two independent complete tenants and derived hierarchy with one status owner',
    async () => {
      const first = await service.getStructure(a.tenant.id);
      const second = await service.getStructure(b.tenant.id);
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
      assert.equal(first.units.find((u) => u.type === 'GROUP')?.parentId, null);
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
        app.query('INSERT INTO organizations.tenant(id,name) VALUES ($1,$2)', [
          a.tenant.id,
          'Duplicate ID',
        ]),
        (error) => state(error, '23505'),
      );
      await assert.rejects(
        app.transaction(async (manager) => {
          const id = randomUUID();
          await manager.query(
            "INSERT INTO organizations.organizational_unit(id,tenant_id,type,name) VALUES ($1,$2,'GROUP','Second')",
            [id, a.tenant.id],
          );
          await manager.query(
            'INSERT INTO organizations.business_group(tenant_id,id) VALUES ($1,$2)',
            [a.tenant.id, id],
          );
        }),
        (error) => state(error, '23505'),
      );
      await assert.rejects(
        app.query(
          'INSERT INTO organizations.company(tenant_id,id,business_group_id) VALUES ($1,$2,$3)',
          [a.tenant.id, ac.company.id, a.group.id],
        ),
        (error) => state(error, '23505'),
      );
      await assert.rejects(
        app.query(
          'INSERT INTO organizations.branch(tenant_id,id,company_id) VALUES ($1,$2,$3)',
          [a.tenant.id, a.group.id, ac.company.id],
        ),
        (error) => state(error, '23503'),
      );
      await assert.rejects(
        app.query(
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
          app.transaction(async (manager) => {
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
        app.query(
          'INSERT INTO organizations.branch(tenant_id,id,company_id) VALUES ($1,$2,$3)',
          [b.tenant.id, ab.branch.id, bc.company.id],
        ),
        (error) => state(error, '23503'),
      );
      await assert.rejects(
        service.createCompany(a.tenant.id, b.group.id, 'Wrong'),
        OrganizationOperationError,
      );
      await assert.rejects(
        service.createBranch(a.tenant.id, bc.company.id, 'Wrong'),
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
          app.transaction(async (manager) => {
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
        app.query(
          "INSERT INTO organizations.organizational_unit(tenant_id,type,name) VALUES ($1,'COMPANY','Orphan')",
          [a.tenant.id],
        ),
        (error) => state(error, '23514'),
      );
      await assert.rejects(
        app.query(
          "INSERT INTO organizations.tenant(name) VALUES ('Missing group')",
        ),
        (error) => state(error, '23514'),
      );
      await assert.rejects(
        app.query(
          'INSERT INTO organizations.branch(tenant_id,id,company_id) VALUES ($1,$2,$3)',
          [a.tenant.id, randomUUID(), randomUUID()],
        ),
        (error) => state(error, '23503'),
      );
      await assert.rejects(
        app.query(
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
      const before = await app.query<{ count: number }[]>(
        'SELECT count(*)::int AS count FROM organizations.tenant',
      );
      await assert.rejects(
        service.createTenant('Rollback tenant', '   '),
        OrganizationOperationError,
      );
      assert.deepEqual(
        await app.query(
          'SELECT count(*)::int AS count FROM organizations.tenant',
        ),
        before,
      );
      const unitId = randomUUID();
      const tenantId = randomUUID();
      await assert.rejects(
        app.transaction(async (manager) => {
          await manager.query(
            "INSERT INTO organizations.tenant(id,name) VALUES ($1,'Incomplete')",
            [tenantId],
          );
          await manager.query(
            "INSERT INTO organizations.organizational_unit(id,tenant_id,type,name) VALUES ($1,$2,'GROUP','Incomplete')",
            [unitId, tenantId],
          );
          // No typed group: statement succeeds, deferred constraint fails at commit.
        }),
        (error) => state(error, '23514'),
      );
      assert.equal(
        (
          await app.query<{ count: number }[]>(
            'SELECT count(*)::int AS count FROM organizations.tenant WHERE id=$1',
            [tenantId],
          )
        )[0].count,
        0,
      );
      assert.equal(
        (
          await app.query<{ count: number }[]>(
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
          service.createCompany(a.tenant.id, a.group.id, `Concurrent ${i}`),
        ),
      );
      assert.equal(new Set(results.map((r) => r.company.id)).size, 6);
      const structure = await service.getStructure(a.tenant.id);
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
      );
      const company = await service.createCompany(
        lifecycle.tenant.id,
        lifecycle.group.id,
        'State company',
      );
      const branch = await service.createBranch(
        lifecycle.tenant.id,
        company.company.id,
        'State branch',
      );
      await service.setStatus(
        lifecycle.tenant.id,
        company.company.id,
        'INACTIVE',
      );
      await assert.rejects(
        service.createBranch(
          lifecycle.tenant.id,
          company.company.id,
          'Rejected',
        ),
        OrganizationOperationError,
      );
      const structure = await service.getStructure(lifecycle.tenant.id);
      assert.equal(
        structure.units.find((u) => u.id === branch.branch.id)?.status,
        'ACTIVE',
      ); // own state, not inherited authority
      await service.setStatus(
        lifecycle.tenant.id,
        branch.branch.id,
        'INACTIVE',
      );
      await assert.rejects(
        service.setStatus(lifecycle.tenant.id, branch.branch.id, 'ACTIVE'),
        OrganizationOperationError,
      );
      await service.setStatus(
        lifecycle.tenant.id,
        company.company.id,
        'ACTIVE',
      );
      await service.setStatus(lifecycle.tenant.id, branch.branch.id, 'ACTIVE');
      await service.setStatus(lifecycle.tenant.id, null, 'INACTIVE');
      await assert.rejects(
        service.createCompany(
          lifecycle.tenant.id,
          lifecycle.group.id,
          'Rejected',
        ),
        OrganizationOperationError,
      );
      await service.setStatus(lifecycle.tenant.id, null, 'ACTIVE');
      await service.setStatus(
        lifecycle.tenant.id,
        company.company.id,
        'ARCHIVED',
      );
      await assert.rejects(
        service.setStatus(lifecycle.tenant.id, company.company.id, 'ACTIVE'),
        OrganizationOperationError,
      );
      await assert.rejects(
        app.query(
          "UPDATE organizations.organizational_unit SET status='ACTIVE' WHERE id=$1",
          [company.company.id],
        ),
        (error) => state(error, '23514'),
      );
      await assert.rejects(
        app.query(
          "UPDATE organizations.tenant SET status='UNKNOWN' WHERE id=$1",
          [lifecycle.tenant.id],
        ),
        (error) => state(error, '23514'),
      );
      const archived = await service.setStatus(
        lifecycle.tenant.id,
        null,
        'ARCHIVED',
      );
      const repeated = await service.setStatus(
        lifecycle.tenant.id,
        null,
        'ARCHIVED',
      );
      assert.equal(repeated.updatedAt.getTime(), archived.updatedAt.getTime());
      await assert.rejects(
        service.setStatus(lifecycle.tenant.id, null, 'INACTIVE'),
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
      ])
        await assert.rejects(migrator.query(sql, [a.tenant.id]), (error) =>
          state(error, '23001', '23503'),
        );
      await assert.rejects(
        migrator.query('DELETE FROM organizations.branch WHERE tenant_id=$1', [
          a.tenant.id,
        ]),
        (error) => state(error, '23514'),
      );
      // Typed keys and parents cannot be moved/retagged by direct SQL either.
      await assert.rejects(
        migrator.query(
          'UPDATE organizations.company SET business_group_id=$1 WHERE tenant_id=$2',
          [b.group.id, a.tenant.id],
        ),
        (error) => state(error, '23514'),
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
        await assert.rejects(app.query(sql), (error) => state(error, '42501'));
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
      // This succeeds intentionally: integrity/tenant filters are NOT RLS or authorization.
      assert.ok(
        (
          await app.query<{ count: number }[]>(
            'SELECT count(*)::int AS count FROM organizations.tenant',
          )
        )[0].count >= 2,
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
}
