import {
  organizationsDiagnosticFixture,
  organizationReadFixture,
  organizationsFixture,
} from './organizations-fixture.spec.js';
import { verifiedPrincipal } from '../authentication/verified-fixture.spec.js';
import { organizationOperation } from '../operations/fixtures.spec.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { DataSource, EntityManager } from 'typeorm';
import pg from 'pg';
import {
  IdentityReadTransactions,
  IdentityService,
} from '../identity/identity.module.js';
import { TenantReadTransactions } from '../context/context.module.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import {
  createDataSource,
  initializeOrganizationsOperatorDataSource,
  initializeMembershipOperatorDataSource,
} from '../persistence/data-sources.js';
import type { Environment } from '../persistence/connection.config.js';
import { provisionDatabase } from '../persistence/provision.js';
import {
  OrganizationsService,
  OrganizationOperationError,
} from './organizations.service.js';

function denied(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '42501'
  );
}
const tables = [
  'tenant',
  'business_group',
  'organizational_unit',
  'company',
  'branch',
];

// SQL uses real restricted roles. This proves tenant RLS, not company/branch
// business authorization. Fixtures belong only to the generated test database.
export async function verifyOrganizationsRls(
  t: TestContext,
  app: DataSource,
  migrator: DataSource,
  env: Environment,
) {
  const operator = await initializeOrganizationsOperatorDataSource(env);
  const diagnostic = await organizationsDiagnosticFixture(operator, env);
  const membershipOperator = await initializeMembershipOperatorDataSource(env);
  const single = createDataSource('app', env);
  single.setOptions({ poolSize: 1 });
  await single.initialize();
  try {
    const writes = await organizationsFixture(operator, env);
    const reads = new OrganizationsService(app);
    const memberships = new MembershipsService(app);
    const membershipWrites = new MembershipsService(membershipOperator);
    const identities = new IdentityService(app);
    const identityScope = new IdentityReadTransactions(app, identities);
    const scope = new TenantReadTransactions(identityScope, memberships, reads);
    const serial = new TenantReadTransactions(
      new IdentityReadTransactions(single, new IdentityService(single)),
      new MembershipsService(single),
      new OrganizationsService(single),
    );
    const principalA = await verifiedPrincipal();
    const principalB = await verifiedPrincipal();
    const principalEmpty = await verifiedPrincipal();
    const aIdentity = await identities.resolve(principalA);
    const bIdentity = await identities.resolve(principalB);
    await identities.resolve(principalEmpty);
    const tenants = [];
    for (const suffix of ['A', 'B', 'C']) {
      const record = await writes.createTenant(
        `RLS tenant ${suffix}`,
        `RLS group ${suffix}`,
        organizationOperation(),
      );
      const company = await writes.createCompany(
        record.tenant.id,
        record.group.id,
        `Private company ${suffix}`,
        `PRIVATE-${suffix}`,
        organizationOperation(),
      );
      await writes.createBranch(
        record.tenant.id,
        company.company.id,
        `Private branch ${suffix}`,
        organizationOperation(),
      );
      tenants.push(record);
    }
    const [a, b, c] = tenants;
    const operation = () => ({
      actor: 'fixture:organizations-rls',
      reason: 'Disposable isolation verification',
      requestId: randomUUID(),
    });
    await membershipWrites.register(a.tenant.id, aIdentity.id, operation());
    await membershipWrites.register(b.tenant.id, aIdentity.id, operation());
    await membershipWrites.register(c.tenant.id, bIdentity.id, operation());
    const directory = (manager: EntityManager) =>
      manager.query<{ tenant_id: string }[]>(
        'SELECT tenant_id,tenant_name,group_id,group_name,available FROM organizations.tenant_directory ORDER BY tenant_id',
      );
    const assertPrivate = async (
      manager: EntityManager,
      expected: string | null,
    ) => {
      for (const table of tables) {
        const rows = await manager.query<{ tenant_id: string }[]>(
          `SELECT ${table === 'tenant' ? 'id' : 'tenant_id'} AS tenant_id FROM organizations.${table}`,
        );
        if (expected) {
          assert.ok(rows.length > 0);
          assert.ok(rows.every((row) => row.tenant_id === expected));
        } else assert.deepEqual(rows, []);
      }
    };

    await t.test(
      'Organizations RLS: ENABLE/FORCE on every private table and exact API/operator privileges',
      async () => {
        const catalog = await migrator.query<
          { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
        >(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='organizations' AND c.relkind='r'",
        );
        assert.equal(catalog.length, 10);
        assert.ok(
          catalog.every((row) => row.relrowsecurity && row.relforcerowsecurity),
        );
        for (const source of [app, operator]) {
          const [role] = await source.query<{ unsafe: boolean }[]>(
            "SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) OR has_schema_privilege(current_user,'organizations','CREATE') AS unsafe FROM pg_roles r WHERE rolname=current_user",
          );
          assert.equal(role.unsafe, false);
        }
        for (const table of tables) {
          const [acl] = await app.query<{ write: boolean }[]>(
            "SELECT has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege(current_user,$1,'INSERT,UPDATE') AS write",
            [`organizations.${table}`],
          );
          assert.equal(acl.write, false);
        }
        for (const sql of [
          'SELECT * FROM memberships.membership',
          'SELECT * FROM identity.user_identity',
          'SELECT * FROM portal_sessions.sessions',
          'SELECT * FROM platform_meta.migrations',
          'CREATE TABLE organizations.forbidden(id int)',
          'DELETE FROM organizations.tenant',
          'UPDATE organizations.company SET tax_id=NULL',
        ])
          await assert.rejects(operator.query(sql), denied);
      },
    );
    await t.test(
      'Organizations RLS: pretenant directory contains only own active options; private SQL and joins are closed',
      async () => {
        assert.deepEqual(await directory(app.manager), []);
        await assertPrivate(app.manager, null);
        for (const [principal, expected] of [
          [principalA, [a.tenant.id, b.tenant.id]],
          [principalB, [c.tenant.id]],
          [principalEmpty, []],
        ] as const) {
          await identityScope.read(principal, async (manager) => {
            assert.deepEqual(
              (await directory(manager)).map((row) => row.tenant_id).sort(),
              [...expected].sort(),
            );
            await assertPrivate(manager, null);
            assert.deepEqual(
              await manager.query(
                'SELECT c.* FROM organizations.tenant_directory d JOIN organizations.company c ON c.tenant_id=d.tenant_id',
              ),
              [],
            );
          });
        }
      },
    );
    await t.test(
      'Organizations RLS: validated tenant scope confines unfiltered SQL, private joins and module reads',
      async () => {
        for (const [principal, tenant] of [
          [principalA, a],
          [principalA, b],
          [principalB, c],
        ] as const) {
          await scope.read(principal, tenant.tenant.id, async (manager) => {
            await assertPrivate(manager, tenant.tenant.id);
            const rows = await manager.query<{ tenant_id: string }[]>(
              'SELECT b.tenant_id FROM organizations.branch b JOIN organizations.company c ON c.tenant_id=b.tenant_id AND c.id=b.company_id JOIN organizations.organizational_unit u ON u.tenant_id=c.tenant_id AND u.id=c.id',
            );
            assert.deepEqual(rows, [{ tenant_id: tenant.tenant.id }]);
            assert.equal(
              (await reads.getStructure(tenant.tenant.id, manager)).tenant.id,
              tenant.tenant.id,
            );
            const foreign = tenant === a ? c : a;
            await assert.rejects(
              reads.getStructure(foreign.tenant.id, manager),
            );
          });
        }
        for (const [principal, id] of [
          [principalA, c.tenant.id],
          [principalB, a.tenant.id],
          [principalEmpty, a.tenant.id],
          [principalA, randomUUID()],
          [principalA, 'malformed'],
        ] as const)
          await assert.rejects(
            scope.read(principal, id, () =>
              assert.fail('Unavailable scope executed'),
            ),
            /Context unavailable/,
          );
        await assert.rejects(
          reads.getStructure(a.tenant.id, operator.manager),
          /Active local transaction/,
        );
      },
    );
    await t.test(
      'Organizations RLS: absent, malformed and foreign identity/tenant settings fail closed without casts',
      async () => {
        for (const identity of ['', 'not-a-uuid', randomUUID(), aIdentity.id]) {
          for (const tenant of ['', 'invalid', randomUUID(), c.tenant.id]) {
            await app.transaction(async (manager) => {
              await manager.query(
                "SELECT set_config('innoview.user_identity_id',$1,true),set_config('innoview.tenant_id',$2,true)",
                [identity, tenant],
              );
              await assertPrivate(manager, null);
            });
          }
        }
        await app.transaction(async (manager) => {
          await manager.query(
            "SELECT set_config('innoview.tenant_id',$1,true)",
            [a.tenant.id],
          );
          await assertPrivate(manager, null);
        });
        await app.transaction(async (manager) => {
          await manager.query(
            "SELECT set_config('innoview.user_identity_id',$1,true),set_config('innoview.tenant_id',$2,true)",
            [bIdentity.id, a.tenant.id],
          );
          await assertPrivate(manager, null);
        });
      },
    );
    await t.test(
      'Organizations RLS: restrictive boundaries survive permissive policies; directory columns cannot grow implicitly',
      async () => {
        await migrator.query(
          'ALTER TABLE organizations.tenant_directory ADD COLUMN private_probe text',
        );
        try {
          await identityScope.read(principalA, async (manager) => {
            assert.equal((await directory(manager)).length, 2);
            await assert.rejects(
              manager.query('SELECT * FROM organizations.tenant_directory'),
              denied,
            );
          });
          for (const table of [...tables, 'tenant_directory'])
            await migrator.query(
              `CREATE POLICY fixture_wide ON organizations.${table} FOR SELECT TO ${pg.escapeIdentifier(env.DB_APP_USER!)} USING(true)`,
            );
          await identityScope.read(principalA, async (manager) => {
            assert.equal((await directory(manager)).length, 2);
            await assertPrivate(manager, null);
          });
          await scope.read(principalA, a.tenant.id, async (manager) =>
            assertPrivate(manager, a.tenant.id),
          );
        } finally {
          for (const table of [...tables, 'tenant_directory'])
            await migrator.query(
              `DROP POLICY IF EXISTS fixture_wide ON organizations.${table}`,
            );
          await migrator.query(
            'ALTER TABLE organizations.tenant_directory DROP COLUMN private_probe',
          );
        }
      },
    );
    await t.test(
      'Organizations RLS: commit and rollback clean both LOCAL contexts on the same physical pool connection',
      async () => {
        const pids = new Set<number>();
        for (const [principal, tenant] of [
          [principalA, a],
          [principalB, c],
          [principalA, b],
        ] as const) {
          await serial.read(principal, tenant.tenant.id, async (manager) => {
            pids.add(
              (
                await manager.query<{ pid: number }[]>(
                  'SELECT pg_backend_pid() AS pid',
                )
              )[0].pid,
            );
            await assertPrivate(manager, tenant.tenant.id);
          });
          const [local] = await single.query<
            { identity: string | null; tenant: string | null }[]
          >(
            "SELECT NULLIF(current_setting('innoview.user_identity_id',true),'') AS identity,NULLIF(current_setting('innoview.tenant_id',true),'') AS tenant",
          );
          assert.deepEqual(local, { identity: null, tenant: null });
          await assertPrivate(single.manager, null);
        }
        await assert.rejects(
          serial.read(principalA, a.tenant.id, async (manager) => {
            pids.add(
              (
                await manager.query<{ pid: number }[]>(
                  'SELECT pg_backend_pid() AS pid',
                )
              )[0].pid,
            );
            throw new Error('Expected rollback');
          }),
          /Expected rollback/,
        );
        await assertPrivate(single.manager, null);
        assert.deepEqual(await directory(single.manager), []);
        assert.deepEqual(
          (
            await single.query<
              { identity: string | null; tenant: string | null }[]
            >(
              "SELECT NULLIF(current_setting('innoview.user_identity_id',true),'') AS identity,NULLIF(current_setting('innoview.tenant_id',true),'') AS tenant",
            )
          )[0],
          { identity: null, tenant: null },
        );
        assert.equal(pids.size, 1);
        // Even inherited session values cannot contaminate the trusted pretenant scope.
        await single.query(
          "SELECT set_config('innoview.user_identity_id',$1,false),set_config('innoview.tenant_id',$2,false)",
          [aIdentity.id, a.tenant.id],
        );
        try {
          await new IdentityReadTransactions(
            single,
            new IdentityService(single),
          ).read(principalB, async (manager) => {
            assert.deepEqual(
              (await directory(manager)).map((row) => row.tenant_id),
              [c.tenant.id],
            );
            await assertPrivate(manager, null);
          });
        } finally {
          await single.query(
            'RESET innoview.user_identity_id; RESET innoview.tenant_id',
          );
        }
      },
    );
    await t.test(
      'Organizations RLS: concurrent requests cannot contaminate identity or selected tenant',
      async () => {
        await Promise.all(
          Array.from({ length: 30 }, (_, i) => {
            const principal = i % 2 ? principalA : principalB;
            const tenant = i % 2 ? (i % 3 ? a : b) : c;
            return scope.read(principal, tenant.tenant.id, async (manager) => {
              await manager.query('SELECT pg_sleep(0.003)');
              await assertPrivate(manager, tenant.tenant.id);
            });
          }),
        );
      },
    );
    await t.test(
      'Organizations RLS: API cannot administer even with valid context; operator audit and directory are derived and atomic',
      async () => {
        for (const sql of [
          "INSERT INTO organizations.tenant(name) VALUES('forbidden')",
          "UPDATE organizations.tenant SET status='INACTIVE'",
          'DELETE FROM organizations.company',
          'TRUNCATE organizations.branch',
        ]) {
          await assert.rejects(
            app.transaction(async (manager) => {
              await manager.query(
                "SELECT set_config('innoview.user_identity_id',$1,true),set_config('innoview.tenant_id',$2,true)",
                [aIdentity.id, a.tenant.id],
              );
              return manager.query<unknown>(sql);
            }),
            denied,
          );
        }
        await assert.rejects(
          new OrganizationsService(app).createTenant(
            'Forbidden',
            'Forbidden',
            organizationOperation(),
          ),
          OrganizationOperationError,
        );
        await assert.rejects(
          operator.query(
            "INSERT INTO organizations.tenant(name) VALUES('missing audit context')",
          ),
          denied,
        );
        await assert.rejects(
          organizationReadFixture(operator, a.tenant.id, (manager) =>
            manager.query(
              'UPDATE organizations.tenant_directory SET available=false',
            ),
          ),
          denied,
        );
        await assert.rejects(
          operator.query(
            "INSERT INTO organizations.audit_event(tenant_id,record_id,record_type,action,actor,db_actor,request_id) VALUES($1,$1,'tenant','INSERT','forged',current_user,$2)",
            [a.tenant.id, randomUUID()],
          ),
          denied,
        );
        const before = await diagnostic.query<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM organizations.audit_event',
        );
        await assert.rejects(
          writes.createTenant(
            'Atomic rollback',
            '   ',
            organizationOperation(),
          ),
          OrganizationOperationError,
        );
        assert.deepEqual(
          await diagnostic.query(
            'SELECT count(*)::int AS n FROM organizations.audit_event',
          ),
          before,
        );
        const events = await diagnostic.query<
          { actor: string; db_actor: string; request_id: string }[]
        >(
          'SELECT actor,db_actor,request_id FROM organizations.audit_event WHERE tenant_id=$1',
          [a.tenant.id],
        );
        assert.equal(events.length, 7); // tenant, group OU/record, company OU/record, branch OU/record
        assert.ok(
          events.every(
            (event) =>
              event.actor &&
              event.request_id &&
              [
                env.DB_ORGANIZATIONS_USER,
                env.DB_ORGANIZATIONS_PROVISIONER_USER,
              ].includes(event.db_actor),
          ),
        );
      },
    );
    await t.test(
      'Organizations RLS: future objects remain private and provisioning repairs column grants without widening roles',
      async () => {
        await migrator.query(
          'CREATE TABLE organizations.future_probe(private_value text)',
        );
        try {
          for (const source of [app, operator])
            await assert.rejects(
              source.query('SELECT * FROM organizations.future_probe'),
              denied,
            );
          await migrator.query(
            `GRANT SELECT(available) ON organizations.tenant_directory TO ${pg.escapeIdentifier(env.DB_PORTAL_USER!)}`,
          );
          await migrator.query(
            `GRANT UPDATE(name) ON organizations.tenant TO ${pg.escapeIdentifier(env.DB_ORGANIZATIONS_USER!)}`,
          );
          await provisionDatabase(env);
          const [acl] = await operator.query<{ granted: boolean }[]>(
            "SELECT has_column_privilege(current_user,'organizations.tenant','name','UPDATE') AS granted",
          );
          assert.equal(acl.granted, false);
          const [bff] = await migrator.query<{ granted: boolean }[]>(
            "SELECT has_any_column_privilege($1,'organizations.tenant_directory','SELECT') AS granted",
            [env.DB_PORTAL_USER],
          );
          assert.equal(bff.granted, false);
          await assert.rejects(
            operator.query('SELECT * FROM organizations.future_probe'),
            denied,
          );
          await assert.rejects(
            initializeOrganizationsOperatorDataSource({
              ...env,
              DB_ORGANIZATIONS_USER: env.DB_APP_USER,
              DB_ORGANIZATIONS_PASSWORD: env.DB_APP_PASSWORD,
            }),
            /role validation failed/,
          );
        } finally {
          await migrator.query('DROP TABLE organizations.future_probe');
        }
      },
    );
    await t.test(
      'Organizations RLS: revocation, inactive/archived tenant and inactive group close subsequent scopes',
      async () => {
        await writes.setStatus(
          a.tenant.id,
          null,
          'INACTIVE',
          organizationOperation(),
        );
        await assert.rejects(
          scope.read(principalA, a.tenant.id, () => undefined),
          /Context unavailable/,
        );
        await writes.setStatus(
          a.tenant.id,
          null,
          'ACTIVE',
          organizationOperation(),
        );
        await writes.setStatus(
          a.tenant.id,
          a.group.id,
          'INACTIVE',
          organizationOperation(),
        );
        await assert.rejects(
          scope.read(principalA, a.tenant.id, () => undefined),
          /Context unavailable/,
        );
        await writes.setStatus(
          a.tenant.id,
          a.group.id,
          'ACTIVE',
          organizationOperation(),
        );
        await scope.read(principalA, a.tenant.id, async (manager) => {
          await membershipWrites.revoke(a.tenant.id, aIdentity.id, operation());
          await assertPrivate(manager, a.tenant.id); // already-started snapshot
        });
        await assert.rejects(
          scope.read(principalA, a.tenant.id, () => undefined),
          /Context unavailable/,
        );
        await writes.setStatus(
          b.tenant.id,
          null,
          'ARCHIVED',
          organizationOperation(),
        );
        await assert.rejects(
          scope.read(principalA, b.tenant.id, () => undefined),
          /Context unavailable/,
        );
        await identityScope.read(principalA, async (manager) =>
          assert.deepEqual(await directory(manager), []),
        );
        await provisionDatabase(env);
        await provisionDatabase(env);
        await scope.read(principalB, c.tenant.id, async (manager) =>
          assertPrivate(manager, c.tenant.id),
        );
        assert.deepEqual(
          await app.query('SELECT * FROM organizations.company'),
          [],
        );
      },
    );
  } finally {
    await single.destroy();
    await membershipOperator.destroy();
    await operator.destroy();
  }
}
