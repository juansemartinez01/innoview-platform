import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { DataSource, EntityManager } from 'typeorm';
import pg from 'pg';
import { setTimeout as pause } from 'node:timers/promises';
import {
  AuthorizationService,
  AuthorizationOperationError,
  permissionCode,
} from './authorization.service.js';
import { AuthorizationModule } from './authorization.module.js';
import { AUTHORIZATION_ACCESS_V1 } from './access.contract.js';
import { Permission, Role, CatalogVersion } from './entities.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import {
  IdentityService,
  IdentityReadTransactions,
} from '../identity/identity.module.js';
import { TenantReadTransactions } from '../context/context.module.js';
import { organizationOperation } from '../operations/fixtures.spec.js';
import {
  establishOperationContext,
  TrustedOperationTransientError,
} from '../operations/operation-context.js';
import {
  canonicalArguments,
  CURRENT_FINGERPRINT_VERSION,
} from '../operations/fingerprint.js';
import {
  initializeAuthorizationOperatorDataSource,
  initializeMembershipOperatorDataSource,
  initializeOrganizationsOperatorDataSource,
  createDataSource,
} from '../persistence/data-sources.js';
import type { Environment } from '../persistence/connection.config.js';
import { securityInvariants } from '../persistence/security-diagnostics.js';
import { provisionDatabase } from '../persistence/provision.js';

const code = (error: unknown, ...codes: string[]) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string' &&
  codes.includes(error.code);
export async function verifyAuthorization(
  t: TestContext,
  app: DataSource,
  migrator: DataSource,
  env: Environment,
) {
  const operator = await initializeAuthorizationOperatorDataSource(env);
  const memberOperator = await initializeMembershipOperatorDataSource(env);
  const orgOperator = await initializeOrganizationsOperatorDataSource(env);
  const orgs = new OrganizationsService(orgOperator),
    members = new MembershipsService(memberOperator),
    identities = new IdentityService(app);
  const service = new AuthorizationService(operator, {
    membershipActive: (tenant, id) =>
      members.activeMembershipReference(tenant, id),
    scopeAvailable: (tenant, id, type) =>
      orgs.availableScopeReference(tenant, id, type),
  });
  const a = await orgs.createTenant(
    'Authorization A',
    'Authorization group A',
    organizationOperation(),
  );
  const b = await orgs.createTenant(
    'Authorization B',
    'Authorization group B',
    organizationOperation(),
  );
  const company = await orgs.createCompany(
    a.tenant.id,
    a.group.id,
    'Authorization company',
    null,
    organizationOperation(),
  );
  const branch = await orgs.createBranch(
    a.tenant.id,
    company.company.id,
    'Authorization branch',
    organizationOperation(),
  );
  const principalA = {
      issuer: 'https://authorization-fixture.invalid',
      subject: randomUUID(),
      clientId: 'innoview-portal',
    },
    principalB = { ...principalA, subject: randomUUID() },
    empty = { ...principalA, subject: randomUUID() };
  const idA = await identities.resolve(principalA),
    idB = await identities.resolve(principalB);
  await identities.resolve(empty);
  const ma = await members.register(
      a.tenant.id,
      idA.id,
      organizationOperation(),
    ),
    mb = await members.register(b.tenant.id, idB.id, organizationOperation());
  const ma2 = await members.register(
    a.tenant.id,
    idB.id,
    organizationOperation(),
  );
  const tenantScope = new TenantReadTransactions(
    new IdentityReadTransactions(app, identities),
    new MembershipsService(app),
    new OrganizationsService(app),
  );
  const read = <T>(
    tenant: string,
    fn: (manager: EntityManager) => Promise<T>,
  ) =>
    operator.transaction('REPEATABLE READ', async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      await establishOperationContext(
        manager,
        'authorization',
        organizationOperation(),
        tenant,
      );
      return fn(manager);
    });
  const raw = <T>(tenant: string, fn: (manager: EntityManager) => Promise<T>) =>
    operator.transaction(async (manager) => {
      const op = organizationOperation();
      await establishOperationContext(manager, 'authorization', op, tenant);
      await manager.query(
        "INSERT INTO \"authorization\".operation(request_id,tenant_id,operation_type,fingerprint,fingerprint_version,actor,actor_type,reason,technical_source) VALUES($1,$2,'ASSIGN',$3,$4,$5,$6,$7,'fixture:raw')",
        [
          op.requestId,
          tenant,
          '0'.repeat(64),
          CURRENT_FINGERPRINT_VERSION,
          op.actor,
          op.actorType,
          op.reason,
        ],
      );
      await manager.query(
        'INSERT INTO "authorization".tenant_revision(tenant_id) VALUES($1) ON CONFLICT DO NOTHING',
        [tenant],
      );
      await manager.query(
        'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1 FOR UPDATE',
        [tenant],
      );
      const value = await fn(manager);
      await manager.query(
        'UPDATE "authorization".operation SET result=\'{}\',completed_at=clock_timestamp() WHERE request_id=$1',
        [op.requestId],
      );
      return value;
    });
  try {
    const ra = await service.createRole(
      a.tenant.id,
      'Reader',
      'Technical role',
      organizationOperation(),
    );
    const rb = await service.createRole(
      b.tenant.id,
      'Reader',
      'Technical role',
      organizationOperation(),
    );
    const link = await service.grantPermission(
      a.tenant.id,
      ra.id,
      'foundation.probe.read',
      organizationOperation(),
    );
    await service.grantPermission(
      b.tenant.id,
      rb.id,
      'foundation.probe.read',
      organizationOperation(),
    );
    const groupAssignment = await service.assign(
      a.tenant.id,
      ma.membership.id,
      ra.id,
      { type: 'GROUP', unitId: a.group.id },
      organizationOperation(),
    );
    const companyAssignment = await service.assign(
      a.tenant.id,
      ma.membership.id,
      ra.id,
      { type: 'COMPANY', unitId: company.company.id },
      organizationOperation(),
    );
    await service.assign(
      a.tenant.id,
      ma.membership.id,
      ra.id,
      { type: 'BRANCH', unitId: branch.branch.id },
      organizationOperation(),
    );
    await service.assign(
      b.tenant.id,
      mb.membership.id,
      rb.id,
      { type: 'GROUP', unitId: b.group.id },
      organizationOperation(),
    );

    await t.test(
      'Authorization catalog: stable namespace, migrator-only mutation, bigint real-change version and terminal deprecation',
      async () => {
        assert.equal(permissionCode('foundation.probe.read'), true);
        assert.equal(permissionCode('foundation..read'), false);
        assert.equal(permissionCode('foundation.probe.read\n'), false);
        const before = await app
          .getRepository(CatalogVersion)
          .findOneByOrFail({ singleton: true });
        assert.equal(typeof before.revision, 'string');
        assert.equal(before.revision, '2');
        const extra = 'a0000000-0000-4000-8000-000000000003';
        await migrator.query(
          "INSERT INTO \"authorization\".permission(id,code,owner_module,description) VALUES($1,'foundation.probe.inspect','foundation','Technical catalog fixture')",
          [extra],
        );
        const next = await app
          .getRepository(CatalogVersion)
          .findOneByOrFail({ singleton: true });
        assert.equal(BigInt(next.revision), BigInt(before.revision) + 1n);
        await migrator.query(
          'UPDATE "authorization".permission SET description=description WHERE id=$1',
          [extra],
        );
        assert.equal(
          (
            await app
              .getRepository(CatalogVersion)
              .findOneByOrFail({ singleton: true })
          ).revision,
          next.revision,
        );
        for (const sql of [
          'UPDATE "authorization".permission SET code=\'foundation.probe.changed\' WHERE id=$1',
          'UPDATE "authorization".permission SET owner_module=\'other\' WHERE id=$1',
          'DELETE FROM "authorization".permission WHERE id=$1',
        ])
          await assert.rejects(migrator.query(sql, [extra]), (error) =>
            code(error, '23514', '42501'),
          );
        await assert.rejects(
          migrator.query(
            "INSERT INTO \"authorization\".permission(code,owner_module,description) VALUES('bad-code','bad','Fixture')",
          ),
          (error) => code(error, '23514'),
        );
        for (const source of [app, operator, memberOperator, orgOperator])
          for (const sql of [
            "INSERT INTO \"authorization\".permission(code,owner_module,description) VALUES('foundation.probe.unknown','foundation','Unauthorized')",
            'UPDATE "authorization".permission SET description=\'unauthorized\'',
            'DELETE FROM "authorization".permission',
          ])
            await assert.rejects(source.query(sql), (error) =>
              code(error, '42501'),
            );
        await migrator.query(
          "UPDATE \"authorization\".permission SET status='DEPRECATED',replaced_by='a0000000-0000-4000-8000-000000000001' WHERE id=$1",
          [extra],
        );
        await assert.rejects(
          migrator.query(
            'UPDATE "authorization".permission SET status=\'ACTIVE\' WHERE id=$1',
            [extra],
          ),
          (error) => code(error, '23514'),
        );
        await assert.rejects(
          service.grantPermission(
            a.tenant.id,
            ra.id,
            'foundation.probe.inspect',
            organizationOperation(),
          ),
          AuthorizationOperationError,
        );
      },
    );
    await t.test(
      'Authorization model: same role name across tenants, unique grants, composite membership/role and typed OU FKs',
      async () => {
        assert.notEqual(ra.id, rb.id);
        await assert.rejects(
          service.createRole(
            a.tenant.id,
            'Reader',
            'Duplicate',
            organizationOperation(),
          ),
          AuthorizationOperationError,
        );
        await assert.rejects(
          service.grantPermission(
            a.tenant.id,
            ra.id,
            'foundation.probe.read',
            organizationOperation(),
          ),
          AuthorizationOperationError,
        );
        for (const [membership, unit, type] of [
          [mb.membership.id, a.group.id, 'GROUP'],
          [ma.membership.id, b.group.id, 'GROUP'],
          [ma.membership.id, a.group.id, 'BRANCH'],
          [randomUUID(), a.group.id, 'GROUP'],
          [ma.membership.id, randomUUID(), 'COMPANY'],
        ]) {
          await assert.rejects(
            raw(a.tenant.id, (manager) =>
              manager.query(
                'INSERT INTO "authorization".role_assignment(tenant_id,membership_id,role_id,scope_unit_id,scope_type) VALUES($1,$2,$3,$4,$5)',
                [a.tenant.id, membership, ra.id, unit, type],
              ),
            ),
            (error) => code(error, '23503'),
          );
        }
        await assert.rejects(
          raw(a.tenant.id, (manager) =>
            manager.query(
              'INSERT INTO "authorization".role_permission(tenant_id,role_id,permission_id) VALUES($1,$2,\'a0000000-0000-4000-8000-000000000001\')',
              [a.tenant.id, rb.id],
            ),
          ),
          (error) => code(error, '23503'),
        );
        const fks = await migrator.query<
          { definition: string; target_index: string }[]
        >(
          "SELECT pg_get_constraintdef(oid) AS definition,conindid::regclass::text AS target_index FROM pg_constraint WHERE conrelid='\"authorization\".role_assignment'::regclass AND contype='f'",
        );
        assert.equal(fks.length, 3);
        assert.ok(
          fks.some((fk) => fk.target_index.includes('uq_unit_tenant_id_type')),
        );
      },
    );
    await t.test(
      'Authorization assignment: real owner contracts reject revoked memberships, inactive/archived scope and inactive ancestors',
      async () => {
        await assert.rejects(
          service.assign(
            a.tenant.id,
            mb.membership.id,
            ra.id,
            { type: 'GROUP', unitId: a.group.id },
            organizationOperation(),
          ),
          AuthorizationOperationError,
        );
        await orgs.setStatus(
          a.tenant.id,
          company.company.id,
          'INACTIVE',
          organizationOperation(),
        );
        await assert.rejects(
          service.assign(
            a.tenant.id,
            ma2.membership.id,
            ra.id,
            { type: 'BRANCH', unitId: branch.branch.id },
            organizationOperation(),
          ),
          AuthorizationOperationError,
        );
        await orgs.setStatus(
          a.tenant.id,
          company.company.id,
          'ACTIVE',
          organizationOperation(),
        );
        await orgs.setStatus(
          a.tenant.id,
          a.group.id,
          'INACTIVE',
          organizationOperation(),
        );
        await assert.rejects(
          service.assign(
            a.tenant.id,
            ma2.membership.id,
            ra.id,
            { type: 'COMPANY', unitId: company.company.id },
            organizationOperation(),
          ),
          AuthorizationOperationError,
        );
        await orgs.setStatus(
          a.tenant.id,
          a.group.id,
          'ACTIVE',
          organizationOperation(),
        );
        await members.revoke(a.tenant.id, idB.id, organizationOperation());
        await assert.rejects(
          service.assign(
            a.tenant.id,
            ma2.membership.id,
            ra.id,
            { type: 'GROUP', unitId: a.group.id },
            organizationOperation(),
          ),
          AuthorizationOperationError,
        );
        const archived = await orgs.createCompany(
          a.tenant.id,
          a.group.id,
          'Archived scope',
          null,
          organizationOperation(),
        );
        await orgs.setStatus(
          a.tenant.id,
          archived.company.id,
          'ARCHIVED',
          organizationOperation(),
        );
        await assert.rejects(
          service.assign(
            a.tenant.id,
            ma.membership.id,
            ra.id,
            { type: 'COMPANY', unitId: archived.company.id },
            organizationOperation(),
          ),
          AuthorizationOperationError,
        );
      },
    );
    await t.test(
      'Authorization RLS: API and operator without context or malformed tenant fail closed; own scope excludes foreign rows',
      async () => {
        for (const source of [app, operator]) {
          for (const value of [
            null,
            '',
            'malformed',
            'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
            randomUUID(),
          ])
            await source.transaction(async (manager) => {
              if (value !== null)
                await manager.query(
                  "SELECT set_config('innoview.tenant_id',$1,true)",
                  [value],
                );
              assert.deepEqual(
                await manager.query('SELECT id FROM "authorization".role'),
                [],
              );
            });
        }
        await read(a.tenant.id, async (manager) => {
          const rows = await manager.query<{ id: string }[]>(
            'SELECT id FROM "authorization".role',
          );
          assert.deepEqual(rows, [{ id: ra.id }]);
        });
        await tenantScope.read(principalA, a.tenant.id, async (manager) => {
          assert.ok(
            (await manager.find(Role)).every(
              (role) => role.tenantId === a.tenant.id,
            ),
          );
          const rows = await manager.query<{ membership_id: string }[]>(
            'SELECT membership_id FROM "authorization".role_assignment',
          );
          assert.ok(rows.length >= 3);
          assert.ok(
            rows.every((row) => row.membership_id === ma.membership.id),
          );
        });
        await new IdentityReadTransactions(app, identities).read(
          principalA,
          async (manager) =>
            assert.deepEqual(
              await manager.query('SELECT id FROM "authorization".role'),
              [],
            ),
        );
        for (const sql of [
          'INSERT INTO "authorization".role(tenant_id,name) VALUES($1,\'Cross tenant\')',
          'UPDATE "authorization".role SET description=\'foreign\' WHERE tenant_id=$1',
        ]) {
          if (sql.startsWith('INSERT'))
            await assert.rejects(
              raw(a.tenant.id, (manager) => manager.query(sql, [b.tenant.id])),
              (error) => code(error, '42501'),
            );
          else
            await raw(a.tenant.id, async (manager) =>
              assert.deepEqual(
                await manager.query(sql + ' RETURNING id', [b.tenant.id]),
                [[], 0],
              ),
            );
        }
      },
    );
    await t.test(
      'Authorization RLS: additional permissive policy cannot widen either API or operator restrictive frontier',
      async () => {
        await migrator.query(
          `CREATE POLICY fixture_wide ON "authorization".role FOR SELECT TO ${pg.escapeIdentifier(env.DB_AUTHORIZATION_USER!)},${pg.escapeIdentifier(env.DB_APP_USER!)} USING(true)`,
        );
        try {
          await read(a.tenant.id, async (manager) =>
            assert.deepEqual(
              await manager.query('SELECT id FROM "authorization".role'),
              [{ id: ra.id }],
            ),
          );
          await tenantScope.read(principalA, a.tenant.id, async (manager) =>
            assert.deepEqual(
              await manager.query('SELECT id FROM "authorization".role'),
              [{ id: ra.id }],
            ),
          );
        } finally {
          await migrator.query(
            'DROP POLICY fixture_wide ON "authorization".role',
          );
        }
      },
    );
    await t.test(
      'Authorization history: terminal revocation, reassignment creates a new row, no permission inheritance or implicit assignments',
      async () => {
        await service.revokeAssignment(
          a.tenant.id,
          groupAssignment.id,
          organizationOperation(),
        );
        const before = await read(a.tenant.id, (manager) =>
          manager.query<unknown[]>(
            'SELECT * FROM "authorization".audit_event WHERE record_id=$1 ORDER BY id',
            [groupAssignment.id],
          ),
        );
        await service.revokeAssignment(
          a.tenant.id,
          groupAssignment.id,
          organizationOperation(),
        );
        assert.deepEqual(
          await read(a.tenant.id, (manager) =>
            manager.query(
              'SELECT * FROM "authorization".audit_event WHERE record_id=$1 ORDER BY id',
              [groupAssignment.id],
            ),
          ),
          before,
        );
        await assert.rejects(
          raw(a.tenant.id, (manager) =>
            manager.query(
              'UPDATE "authorization".role_assignment SET status=\'ACTIVE\' WHERE id=$1',
              [groupAssignment.id],
            ),
          ),
          (error) => code(error, '23514'),
        );
        await service.revokePermission(
          a.tenant.id,
          link.id,
          organizationOperation(),
        );
        await assert.rejects(
          raw(a.tenant.id, (manager) =>
            manager.query(
              'UPDATE "authorization".role_permission SET status=\'ACTIVE\' WHERE id=$1',
              [link.id],
            ),
          ),
          (error) => code(error, '23514'),
        );
        await service.grantPermission(
          a.tenant.id,
          ra.id,
          'foundation.probe.read',
          organizationOperation(),
        );
        const again = await service.assign(
          a.tenant.id,
          ma.membership.id,
          ra.id,
          { type: 'GROUP', unitId: a.group.id },
          organizationOperation(),
        );
        assert.notEqual(again.id, groupAssignment.id);
        const own = await read(a.tenant.id, (manager) =>
          manager.query<{ scope_type: string; status: string }[]>(
            'SELECT scope_type,status FROM "authorization".role_assignment WHERE membership_id=$1',
            [ma.membership.id],
          ),
        );
        assert.equal(own.filter((row) => row.status === 'ACTIVE').length, 3);
        await tenantScope
          .read(empty, a.tenant.id, () =>
            assert.fail('Membership absent must not establish tenant'),
          )
          .catch((error) => assert.match(String(error), /Context unavailable/));
      },
    );
    await t.test(
      'Authorization operations: concurrent idempotence, module/version envelope, conflict across tenant and atomic audit rollback',
      async () => {
        const op = organizationOperation();
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            service.createRole(
              a.tenant.id,
              'Concurrent authorization',
              'Fixture',
              op,
            ),
          ),
        );
        for (const result of results) assert.deepEqual(result, results[0]);
        const records = await read(a.tenant.id, (manager) =>
          manager.query<{ n: number }[]>(
            'SELECT count(*)::int AS n FROM "authorization".audit_event WHERE operation_request_id=$1',
            [op.requestId],
          ),
        );
        assert.equal(records[0].n, 1);
        const [stored] = await read(a.tenant.id, (manager) =>
          manager.query<{ fingerprint: string; fingerprint_version: number }[]>(
            'SELECT fingerprint,fingerprint_version FROM "authorization".operation WHERE request_id=$1',
            [op.requestId],
          ),
        );
        assert.equal(stored.fingerprint_version, CURRENT_FINGERPRINT_VERSION);
        assert.equal(
          stored.fingerprint,
          createHash('sha256')
            .update(
              canonicalArguments({
                module: 'authorization',
                version: CURRENT_FINGERPRINT_VERSION,
                operation: 'CREATE_ROLE',
                args: {
                  tenantId: a.tenant.id,
                  name: 'Concurrent authorization',
                  description: 'Fixture',
                },
              }),
            )
            .digest('hex'),
        );
        await assert.rejects(
          service.createRole(a.tenant.id, 'Different args', 'Fixture', op),
          (error) =>
            error instanceof AuthorizationOperationError &&
            error.code === 'REQUEST_ID_CONFLICT',
        );
        await assert.rejects(
          service.createRole(
            b.tenant.id,
            'Concurrent authorization',
            'Fixture',
            op,
          ),
          (error) =>
            error instanceof AuthorizationOperationError &&
            error.code === 'REQUEST_ID_CONFLICT',
        );
        const bad = organizationOperation();
        await assert.rejects(
          service.assign(
            a.tenant.id,
            randomUUID(),
            ra.id,
            { type: 'GROUP', unitId: a.group.id },
            bad,
          ),
          AuthorizationOperationError,
        );
        await read(a.tenant.id, async (manager) => {
          assert.deepEqual(
            await manager.query(
              'SELECT request_id FROM "authorization".operation WHERE request_id=$1',
              [bad.requestId],
            ),
            [],
          );
          assert.deepEqual(
            await manager.query(
              'SELECT id FROM "authorization".audit_event WHERE operation_request_id=$1',
              [bad.requestId],
            ),
            [],
          );
        });
        await assert.rejects(
          raw(a.tenant.id, (manager) =>
            manager.query(
              "INSERT INTO \"authorization\".audit_event(tenant_id,operation_request_id,record_type,record_id,action,actor,actor_type,reason,technical_source,db_actor) VALUES($1,$2,'role',$3,'INSERT','forged','SYSTEM','forged','forged',current_user)",
              [a.tenant.id, op.requestId, ra.id],
            ),
          ),
          (error) => code(error, '42501'),
        );
        for (const sql of [
          'DELETE FROM "authorization".audit_event',
          'SELECT * FROM portal_sessions.sessions',
          'SELECT * FROM memberships.membership',
          'SELECT * FROM organizations.tenant',
          'CREATE TABLE "authorization".forbidden(id int)',
        ])
          await assert.rejects(operator.query(sql), (error) =>
            code(error, '42501'),
          );
        assert.deepEqual(
          await operator.query(
            'UPDATE "authorization".operation SET result=\'{}\' RETURNING request_id',
          ),
          [[], 0],
        );
        await assert.rejects(
          raw(a.tenant.id, (manager) =>
            manager.query(
              'UPDATE "authorization".operation SET result=\'{}\' WHERE request_id=$1',
              [op.requestId],
            ),
          ),
          (error) => code(error, '42501'),
        );
      },
    );
    await t.test(
      'Authorization revision: bigint atomic increments serialize tenant changes, no-op and replay do not increment',
      async () => {
        const revision = async () =>
          BigInt(
            (
              await read(a.tenant.id, (manager) =>
                manager.query<{ revision: string }[]>(
                  'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1',
                  [a.tenant.id],
                ),
              )
            )[0].revision,
          );
        const start = await revision();
        await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            service.createRole(
              a.tenant.id,
              `Revision ${i}`,
              'Fixture',
              organizationOperation(),
            ),
          ),
        );
        assert.equal(await revision(), start + 12n);
        const op = organizationOperation();
        await service.setRoleStatus(a.tenant.id, ra.id, 'INACTIVE', op);
        const changed = await revision();
        assert.equal(changed, start + 13n);
        await service.setRoleStatus(
          a.tenant.id,
          ra.id,
          'INACTIVE',
          organizationOperation(),
        );
        await service.setRoleStatus(a.tenant.id, ra.id, 'INACTIVE', op);
        assert.equal(await revision(), changed);
        await service.setRoleStatus(
          a.tenant.id,
          ra.id,
          'ACTIVE',
          organizationOperation(),
        );
        await read(a.tenant.id, async (manager) => {
          const [revision] = await manager.query<{ type: string }[]>(
            'SELECT pg_typeof(revision)::text AS type FROM "authorization".tenant_revision',
          );
          assert.equal(revision.type, 'bigint');
        });
      },
    );
    await t.test(
      'Authorization availability: stored ACTIVE grants survive deprecation/revocation/inactive ancestor but are not claimed effective',
      async () => {
        await service.grantPermission(
          a.tenant.id,
          ra.id,
          'foundation.probe.write',
          organizationOperation(),
        );
        await migrator.query(
          "UPDATE \"authorization\".permission SET status='DEPRECATED' WHERE code='foundation.probe.write'",
        );
        await assert.rejects(
          service.grantPermission(
            b.tenant.id,
            rb.id,
            'foundation.probe.write',
            organizationOperation(),
          ),
          AuthorizationOperationError,
        );
        await orgs.setStatus(
          a.tenant.id,
          company.company.id,
          'INACTIVE',
          organizationOperation(),
        );
        await read(a.tenant.id, async (manager) => {
          const [stored] = await manager.query<{ status: string }[]>(
            'SELECT status FROM "authorization".role_assignment WHERE id=$1',
            [companyAssignment.id],
          );
          assert.equal(stored.status, 'ACTIVE');
        });
        await orgs.setStatus(
          a.tenant.id,
          company.company.id,
          'ACTIVE',
          organizationOperation(),
        );
        await members.revoke(a.tenant.id, idA.id, organizationOperation());
        await read(a.tenant.id, async (manager) =>
          assert.equal(
            (
              await manager.query<{ status: string }[]>(
                'SELECT status FROM "authorization".role_assignment WHERE id=$1',
                [companyAssignment.id],
              )
            )[0].status,
            'ACTIVE',
          ),
        );
        await assert.rejects(
          tenantScope.read(principalA, a.tenant.id, () => undefined),
          /Context unavailable/,
        );
        assert.equal(
          (
            await app
              .getRepository(Permission)
              .findOneByOrFail({ code: 'foundation.probe.write' })
          ).status,
          'DEPRECATED',
        );
        // 2.4 must combine these current states; no can() evaluator is invoked here.
      },
    );
    await t.test(
      'Authorization pool: commit, rollback, contention and concurrency never leak LOCAL context or partial audit',
      async () => {
        const single = createDataSource('authorization', env);
        single.setOptions({ poolSize: 1 });
        await single.initialize();
        const localService = new AuthorizationService(single);
        try {
          for (const tenant of [a.tenant.id, b.tenant.id, a.tenant.id])
            await localService.createRole(
              tenant,
              `Pool ${randomUUID()}`,
              'Fixture',
              organizationOperation(),
            );
          await assert.rejects(
            localService.createRole(
              a.tenant.id,
              'Reader',
              'Duplicate',
              organizationOperation(),
            ),
            AuthorizationOperationError,
          );
          const [state] = await single.query<
            { tenant: string | null; request: string | null }[]
          >(
            "SELECT NULLIF(current_setting('innoview.tenant_id',true),'') AS tenant,NULLIF(current_setting('innoview.authorization_request',true),'') AS request",
          );
          assert.deepEqual(state, { tenant: null, request: null });
          assert.deepEqual(
            await single.query('SELECT id FROM "authorization".role'),
            [],
          );
          const [beforePid] = await single.query<{ pid: number }[]>(
            'SELECT pg_backend_pid() AS pid',
          );
          const blocker = operator.createQueryRunner();
          const blocked = organizationOperation();
          await blocker.connect();
          await blocker.startTransaction();
          try {
            await establishOperationContext(
              blocker.manager,
              'authorization',
              organizationOperation(),
              a.tenant.id,
            );
            await blocker.query(
              'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1 FOR UPDATE',
              [a.tenant.id],
            );
            await assert.rejects(
              localService.createRole(
                a.tenant.id,
                'Recovered authorization',
                'Fixture',
                blocked,
              ),
              (error) =>
                error instanceof TrustedOperationTransientError &&
                error.code === '55P03' &&
                error.retryable,
            );
          } finally {
            await blocker.rollbackTransaction();
            await blocker.release();
          }
          const [after] = await single.query<
            {
              pid: number;
              tenant: string | null;
              request: string | null;
              lock: string;
            }[]
          >(
            "SELECT pg_backend_pid() AS pid,NULLIF(current_setting('innoview.tenant_id',true),'') AS tenant,NULLIF(current_setting('innoview.authorization_request',true),'') AS request,current_setting('lock_timeout') AS lock",
          );
          assert.deepEqual(after, {
            pid: beforePid.pid,
            tenant: null,
            request: null,
            lock: '1s',
          });
          await read(a.tenant.id, async (manager) => {
            assert.deepEqual(
              await manager.query(
                'SELECT request_id FROM "authorization".operation WHERE request_id=$1',
                [blocked.requestId],
              ),
              [],
            );
            assert.deepEqual(
              await manager.query(
                'SELECT id FROM "authorization".audit_event WHERE operation_request_id=$1',
                [blocked.requestId],
              ),
              [],
            );
          });
          const recovered = await localService.createRole(
            a.tenant.id,
            'Recovered authorization',
            'Fixture',
            blocked,
          );
          assert.deepEqual(
            await localService.createRole(
              a.tenant.id,
              'Recovered authorization',
              'Fixture',
              blocked,
            ),
            recovered,
          );
        } finally {
          await single.destroy();
        }
      },
    );
    await t.test(
      'Authorization port: registered evaluator is separate from trusted writes; API cannot perform trusted writes',
      async () => {
        const providers: unknown = Reflect.getMetadata(
          'providers',
          AuthorizationModule,
        );
        assert.ok(Array.isArray(providers));
        assert.ok(
          providers.some(
            (p: unknown) =>
              typeof p === 'object' &&
              p !== null &&
              'provide' in p &&
              p.provide === AUTHORIZATION_ACCESS_V1,
          ),
        );
        assert.equal(
          (Reflect.getMetadata('controllers', AuthorizationModule) as unknown[])
            .length,
          1,
        );
        await assert.rejects(
          new AuthorizationService(app).createRole(
            a.tenant.id,
            'Forbidden',
            'Fixture',
            organizationOperation(),
          ),
          (error) =>
            error instanceof AuthorizationOperationError &&
            error.code === 'OPERATOR_REQUIRED',
        );
      },
    );
    await t.test(
      'Authorization diagnostics: explicit catalog/tenant classification detects operator catalog mutation, unexpected tables and policies',
      async () => {
        assert.deepEqual((await securityInvariants(orgOperator)).findings, []);
        await migrator.query(
          'CREATE FUNCTION "authorization".require_operation(value text) RETURNS text LANGUAGE sql AS $$ SELECT value $$',
        );
        await migrator.query(
          `GRANT EXECUTE ON FUNCTION "authorization".require_operation(text) TO ${pg.escapeIdentifier(env.DB_AUTHORIZATION_USER!)}`,
        );
        try {
          assert.ok(
            (await securityInvariants(orgOperator)).findings.some((value) =>
              value.startsWith(
                'FUNCTION_ACL:authorization:authorization.require_operation(',
              ),
            ),
          );
        } finally {
          await migrator.query(
            'DROP FUNCTION "authorization".require_operation(text)',
          );
        }
        await migrator.query(
          `GRANT UPDATE(description) ON "authorization".permission TO ${pg.escapeIdentifier(env.DB_AUTHORIZATION_USER!)}`,
        );
        try {
          assert.ok(
            (await securityInvariants(orgOperator)).findings.some((value) =>
              value.startsWith(
                'COLUMN_ACL:authorization:authorization.permission:description:UPDATE',
              ),
            ),
          );
        } finally {
          await provisionDatabase(env);
        }
        await migrator.query(
          'ALTER POLICY operator_boundary ON "authorization".role USING(true) WITH CHECK(true)',
        );
        try {
          assert.ok(
            (await securityInvariants(orgOperator)).findings.includes(
              'AUTH_POLICY_CONTRACT:authorization:authorization.role:boundary',
            ),
          );
        } finally {
          const [select] = await migrator.query<{ qual: string }[]>(
            "SELECT qual FROM pg_policies WHERE schemaname='authorization' AND tablename='role' AND policyname='operator_select'",
          );
          await migrator.query(
            `ALTER POLICY operator_boundary ON "authorization".role USING(${select.qual}) WITH CHECK(${select.qual})`,
          );
        }
        await migrator.query(
          'CREATE TABLE "authorization".unknown_contract(tenant_id uuid)',
        );
        try {
          assert.ok(
            (await securityInvariants(orgOperator)).findings.includes(
              'UNCLASSIFIED_CONTRACT:authorization.unknown_contract',
            ),
          );
        } finally {
          await migrator.query('DROP TABLE "authorization".unknown_contract');
        }
        assert.deepEqual((await securityInvariants(orgOperator)).findings, []);
      },
    );
    await t.test(
      'N1/N2: Organizations concurrent replay tolerates a bounded delay greater than role default and uses one fingerprint version constant',
      async () => {
        const op = organizationOperation();
        await migrator.query(
          `CREATE FUNCTION organizations.fixture_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${op.requestId}'::uuid THEN PERFORM pg_sleep(1.6); END IF;RETURN NEW;END $$`,
        );
        await migrator.query(
          'CREATE TRIGGER fixture_delay AFTER INSERT ON organizations.operation FOR EACH ROW EXECUTE FUNCTION organizations.fixture_delay()',
        );
        try {
          const first = orgs.createTenant(
            'Contention fixture',
            'Contention group',
            op,
          );
          await pause(100);
          const second = orgs.createTenant(
            'Contention fixture',
            'Contention group',
            op,
          );
          assert.deepEqual(await first, await second);
          const [version] = await orgOperator.query<
            { fingerprint_version: number }[]
          >(
            'SELECT fingerprint_version FROM organizations.operation WHERE request_id=$1',
            [op.requestId],
          );
          assert.equal(
            version.fingerprint_version,
            CURRENT_FINGERPRINT_VERSION,
          );
        } finally {
          await migrator.query(
            'DROP TRIGGER fixture_delay ON organizations.operation',
          );
          await migrator.query('DROP FUNCTION organizations.fixture_delay()');
        }
        const [constraint] = await migrator.query<{ convalidated: boolean }[]>(
          "SELECT convalidated FROM pg_constraint WHERE conrelid='organizations.operation'::regclass AND conname='organization_operation_technical_source'",
        );
        assert.equal(constraint.convalidated, true);
      },
    );
  } finally {
    await operator.destroy();
    await memberOperator.destroy();
    await orgOperator.destroy();
  }
}
