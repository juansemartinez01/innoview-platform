import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { DataSource } from 'typeorm';
import type { Environment } from '../persistence/connection.config.js';
import {
  initializeAuthorizationDelegationDataSource,
  initializeAuthorizationOperatorDataSource,
  initializeMembershipOperatorDataSource,
  initializeOrganizationsOperatorDataSource,
  initializeDirectoryMaintenanceDataSource,
  createDataSource,
} from '../persistence/data-sources.js';
import { organizationsFixture } from '../organizations/organizations-fixture.spec.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import { IdentityService } from '../identity/identity.module.js';
import { verifiedPrincipal } from '../authentication/verified-fixture.spec.js';
import { establishOperationContext } from '../operations/operation-context.js';
import { establishOperationLocals } from '../operations/operation-context.js';
import { delegatedOperation } from './delegation.js';
import { organizationOperation as op } from '../operations/fixtures.spec.js';
import { AuthorizationService } from './authorization.service.js';
import {
  DelegatedAssignments,
  type DelegatedAssignment,
} from './delegation.js';
import { securityInvariants } from '../persistence/security-diagnostics.js';

export async function verifyDelegation(
  t: TestContext,
  app: DataSource,
  migrator: DataSource,
  env: Environment,
) {
  const delegation = await initializeAuthorizationDelegationDataSource(env),
    technical = await initializeAuthorizationOperatorDataSource(env),
    memberSource = await initializeMembershipOperatorDataSource(env),
    orgSource = await initializeOrganizationsOperatorDataSource(env),
    diagnostic = await initializeDirectoryMaintenanceDataSource(env);
  try {
    const orgs = await organizationsFixture(orgSource, env),
      members = new MembershipsService(memberSource),
      ids = new IdentityService(app);
    const auth = new AuthorizationService(technical, {
      membershipActive: (t, m) => members.activeMembershipReference(t, m),
      scopeAvailable: (t, u, type) => orgs.availableScopeReference(t, u, type),
    });
    const service = new DelegatedAssignments(delegation);
    const a = await orgs.createTenant('Delegation A', 'Group A', op()),
      b = await orgs.createTenant('Delegation B', 'Group B', op());
    const tenant = a.tenant.id;
    const inspect = <T>(sql: string, params: unknown[] = []) =>
      technical.transaction(async (manager) => {
        await establishOperationContext(manager, 'authorization', op(), tenant);
        return manager.query<T>(sql, params);
      });
    const x = await orgs.createCompany(tenant, a.group.id, 'X', null, op()),
      y = await orgs.createCompany(tenant, a.group.id, 'Y', null, op());
    const branch = await orgs.createBranch(
      tenant,
      x.company.id,
      'X branch',
      op(),
    );
    const scope = { type: 'COMPANY' as const, unitId: x.company.id };
    const principals = await Promise.all([
      verifiedPrincipal(),
      verifiedPrincipal(),
      verifiedPrincipal(),
      verifiedPrincipal(),
    ]);
    const identities = await Promise.all(principals.map((p) => ids.resolve(p)));
    const memberships = await Promise.all(
      identities.map((i) => members.register(tenant, i.id, op())),
    );
    const foreign = await members.register(b.tenant.id, identities[0].id, op());
    const admin = await auth.createRole(
        tenant,
        'Initial admin',
        'Fixture',
        op(),
      ),
      ordinary = await auth.createRole(tenant, 'Reader', 'Fixture', op()),
      excess = await auth.createRole(tenant, 'Writer', 'Fixture', op());
    await auth.grantPermission(
      tenant,
      admin.id,
      'authorization.assignment.grant',
      op(),
    );
    await auth.grantPermission(tenant, admin.id, 'foundation.probe.read', op());
    await auth.grantPermission(
      tenant,
      ordinary.id,
      'foundation.probe.read',
      op(),
    );
    await auth.grantPermission(
      tenant,
      excess.id,
      'foundation.probe.write',
      op(),
    );
    const bootstrap = { ...op(), actorType: 'INNOVIEW_OPERATOR' as const };
    const initial = await auth.assign(
      tenant,
      memberships[0].membership.id,
      admin.id,
      scope,
      bootstrap,
      'GRANT_TENANT_ADMIN',
    );
    const request = (
      change: Partial<DelegatedAssignment> = {},
    ): DelegatedAssignment => ({
      requestId: randomUUID(),
      membershipId: memberships[1].membership.id,
      roleId: ordinary.id,
      scopeType: scope.type,
      scopeUnitId: scope.unitId,
      reason: 'Discardable delegated assignment',
      ...change,
    });
    const raw = async (value: DelegatedAssignment, actor = 0) => {
      const runner = delegation.createQueryRunner();
      await runner.connect();
      await runner.startTransaction('READ COMMITTED');
      const operation = delegatedOperation(
        identities[actor].id,
        memberships[actor].membership.id,
        value,
      );
      await establishOperationLocals(
        runner.manager,
        'authorization',
        operation,
        tenant,
      );
      await runner.query(
        "SELECT set_config('innoview.user_identity_id',$1,true),set_config('innoview.delegation_actor_membership',$2,true),set_config('innoview.delegation_target_membership',$3,true)",
        [
          identities[actor].id,
          memberships[actor].membership.id,
          value.membershipId,
        ],
      );
      await runner.query(
        'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1 FOR UPDATE',
        [tenant],
      );
      await runner.query(
        'SET CONSTRAINTS "authorization".operation_tenant_id_fkey DEFERRED',
      );
      await runner.query(
        `INSERT INTO "authorization".operation(request_id,tenant_id,operation_type,fingerprint,fingerprint_version,actor,actor_type,reason,technical_source,actor_membership_id,actor_user_identity_id) VALUES($1,$2,'DELEGATED_ASSIGN',$3,2,$4::text,'USER_IDENTITY',$5,'fixture:direct-sql',$6,$4::uuid)`,
        [
          operation.requestId,
          tenant,
          '0'.repeat(64),
          identities[actor].id,
          operation.reason,
          memberships[actor].membership.id,
        ],
      );
      return runner;
    };
    const insertRaw = (
      runner: Awaited<ReturnType<typeof raw>>,
      value: DelegatedAssignment,
    ) =>
      runner.query(
        'INSERT INTO "authorization".role_assignment(tenant_id,membership_id,role_id,scope_type,scope_unit_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [
          tenant,
          value.membershipId,
          value.roleId,
          value.scopeType,
          value.scopeUnitId,
        ],
      );
    const rollback = async (runner: Awaited<ReturnType<typeof raw>>) => {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    };
    const reject = async (
      p = principals[0],
      value = request(),
      tenantId = tenant,
    ) => assert.rejects(service.assign(p, tenantId, value));
    const successful = request();
    let result: unknown;
    await t.test(
      'Delegation 1: verified A assigns an existing contained role to B on exact Company X',
      async () => {
        result = await service.assign(principals[0], tenant, successful);
        assert.ok(result);
      },
    );
    await t.test(
      'Delegation 2/3/11: B has ordinary permission, never administrative authority or extra grants',
      async () => {
        await reject(
          principals[1],
          request({ membershipId: memberships[2].membership.id }),
        );
        await reject(
          principals[1],
          request({
            membershipId: memberships[2].membership.id,
            roleId: excess.id,
          }),
        );
        await reject(principals[3]);
      },
    );
    await t.test(
      'Delegation 4/5/13: Company Y, COMPANY to BRANCH, and GROUP to COMPANY never inherit authority',
      async () => {
        await reject(principals[0], request({ scopeUnitId: y.company.id }));
        await reject(
          principals[0],
          request({ scopeType: 'BRANCH', scopeUnitId: branch.branch.id }),
        );
        await auth.assign(
          tenant,
          memberships[2].membership.id,
          admin.id,
          { type: 'GROUP', unitId: a.group.id },
          { ...op(), actorType: 'INNOVIEW_OPERATOR' },
          'GRANT_TENANT_ADMIN',
        );
        await reject(principals[2], request());
      },
    );
    await t.test(
      'Delegation containment: additional permission, reserved namespace and self-elevation all deny uniformly',
      async () => {
        for (const roleId of [admin.id, excess.id])
          await reject(
            principals[0],
            request({ roleId, membershipId: memberships[0].membership.id }),
          );
      },
    );
    await t.test(
      'Delegation 9/16: concurrent identical request replays once, altered arguments conflict',
      async () => {
        const replay = await Promise.all(
          Array.from({ length: 5 }, () =>
            service.assign(principals[0], tenant, successful),
          ),
        );
        for (const value of replay) assert.deepEqual(value, result);
        await assert.rejects(
          service.assign(principals[0], tenant, {
            ...successful,
            reason: 'Different reason',
          }),
          (e) =>
            typeof e === 'object' &&
            e !== null &&
            'getStatus' in e &&
            (e as { getStatus(): number }).getStatus() === 409,
        );
        const [counts] = await inspect<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM "authorization".audit_event WHERE operation_request_id=$1',
          [successful.requestId],
        );
        assert.equal(counts.n, 1);
      },
    );
    await t.test(
      'Delegation first-execution race: one request creates exactly one assignment/audit/revision; duplicate active grant is a safe conflict',
      async () => {
        const raceRole = await auth.createRole(
          tenant,
          'Concurrent fresh request role',
          'Fixture',
          op(),
        );
        await auth.grantPermission(
          tenant,
          raceRole.id,
          'foundation.probe.read',
          op(),
        );
        const value = request({ roleId: raceRole.id });
        const [before] = await inspect<{ revision: string }[]>(
          'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1',
          [tenant],
        );
        const results = await Promise.all(
          Array.from({ length: 6 }, () =>
            service.assign(principals[0], tenant, value),
          ),
        );
        for (const result of results) assert.deepEqual(result, results[0]);
        const [after] = await inspect<{ revision: string }[]>(
          'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1',
          [tenant],
        );
        assert.equal(BigInt(after.revision), BigInt(before.revision) + 1n);
        const [events] = await inspect<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM "authorization".audit_event WHERE operation_request_id=$1',
          [value.requestId],
        );
        assert.equal(events.n, 1);
        await assert.rejects(
          service.assign(principals[0], tenant, {
            ...value,
            requestId: randomUUID(),
          }),
          (e) =>
            typeof e === 'object' &&
            e !== null &&
            'getStatus' in e &&
            (e as { getStatus(): number }).getStatus() === 409,
        );
      },
    );
    await t.test(
      'Delegation reserved history: revoked authorization namespace association still forbids delegation',
      async () => {
        const reserved = await auth.createRole(
          tenant,
          'Historical reserved role',
          'Fixture',
          op(),
        );
        const grant = await auth.grantPermission(
          tenant,
          reserved.id,
          'authorization.role.define',
          op(),
        );
        await auth.revokePermission(tenant, grant.id, op());
        await auth.grantPermission(
          tenant,
          reserved.id,
          'foundation.probe.read',
          op(),
        );
        await reject(principals[0], request({ roleId: reserved.id }));
        await assert.rejects(
          auth.assign(
            tenant,
            memberships[1].membership.id,
            admin.id,
            scope,
            op(),
          ),
        );
      },
    );
    await t.test(
      'Delegation G2: missing/NULL tenant and request are rejected before lock acquisition',
      async () => {
        for (const tenantId of [undefined, '', 'invalid'])
          await assert.rejects(
            delegation.transaction((manager) =>
              establishOperationLocals(
                manager,
                'authorization',
                {
                  actor: identities[0].id,
                  actorType: 'USER_IDENTITY',
                  reason: 'Fixture',
                  requestId: randomUUID(),
                },
                tenantId,
              ),
            ),
            /Canonical tenant/,
          );
        await assert.rejects(
          delegation.transaction((manager) =>
            establishOperationLocals(
              manager,
              'authorization',
              {
                actor: identities[0].id,
                actorType: 'USER_IDENTITY',
                reason: 'Fixture',
                requestId: '',
              },
              tenant,
            ),
          ),
          /Canonical tenant/,
        );
      },
    );
    await t.test(
      'Delegation H4: human ledger and derived audit bind tenant, Membership and Identity durably',
      async () => {
        for (const table of ['operation', 'audit_event']) {
          const [row] = await inspect<
            {
              actor_membership_id: string;
              actor_user_identity_id: string;
              actor_type: string;
            }[]
          >(
            `SELECT actor_membership_id,actor_user_identity_id,actor_type FROM "authorization".${table} WHERE ${table === 'operation' ? 'request_id' : 'operation_request_id'}=$1`,
            [successful.requestId],
          );
          assert.equal(row.actor_membership_id, memberships[0].membership.id);
          assert.equal(row.actor_user_identity_id, identities[0].id);
          assert.equal(row.actor_type, 'USER_IDENTITY');
        }
      },
    );
    await t.test(
      'Delegation 6/12: arbitrary SQL cannot edit shared roles/composition/catalog, update assignments or read sessions',
      async () => {
        for (const sql of [
          'INSERT INTO "authorization".role(tenant_id,name) VALUES($1,\'forbidden\')',
          'INSERT INTO "authorization".role_permission(tenant_id,role_id,permission_id) VALUES($1,$2,$3)',
          'UPDATE "authorization".role_assignment SET status=\'REVOKED\'',
          'SELECT * FROM portal_sessions.sessions',
          'SELECT created_at FROM identity.user_identity',
        ])
          await assert.rejects(
            delegation.query(
              sql,
              sql.includes('$3')
                ? [tenant, ordinary.id, randomUUID()]
                : sql.includes('$1')
                  ? [tenant]
                  : [],
            ),
          );
        await assert.rejects(
          delegation.query(
            'INSERT INTO "authorization".role_assignment(tenant_id,membership_id,role_id,scope_type,scope_unit_id) VALUES($1,$2,$3,\'COMPANY\',$4)',
            [tenant, memberships[2].membership.id, ordinary.id, scope.unitId],
          ),
        );
        await assert.rejects(
          new AuthorizationService(delegation).assign(
            tenant,
            memberships[1].membership.id,
            admin.id,
            scope,
            bootstrap,
            'GRANT_TENANT_ADMIN',
          ),
        );
      },
    );
    await t.test(
      'Delegation SQL provenance: technical USER_IDENTITY and delegated GRANT_TENANT_ADMIN are rejected by PostgreSQL',
      async () => {
        for (const [source, human] of [
          [technical, true],
          [delegation, false],
        ] as const)
          await assert.rejects(
            source.transaction(async (manager) => {
              const context = {
                requestId: randomUUID(),
                actor: human ? identities[0].id : 'fixture:forged-bootstrap',
                actorType: human ? 'USER_IDENTITY' : 'INNOVIEW_OPERATOR',
                reason: 'Adversarial SQL provenance',
              };
              await establishOperationLocals(
                manager,
                'authorization',
                context,
                tenant,
              );
              await manager.query(
                "SELECT set_config('innoview.user_identity_id',$1,true),set_config('innoview.delegation_actor_membership',$2,true)",
                [identities[0].id, memberships[0].membership.id],
              );
              await manager.query(
                `INSERT INTO "authorization".operation(request_id,tenant_id,operation_type,fingerprint,fingerprint_version,actor,actor_type,reason,technical_source,actor_membership_id,actor_user_identity_id) VALUES($1,$2,$3,$4,2,$5,$6,$7,'fixture:forged-provenance',$8,$9)`,
                [
                  context.requestId,
                  tenant,
                  human ? 'DELEGATED_ASSIGN' : 'GRANT_TENANT_ADMIN',
                  '0'.repeat(64),
                  context.actor,
                  context.actorType,
                  context.reason,
                  human ? memberships[0].membership.id : null,
                  human ? identities[0].id : null,
                ],
              );
            }),
            (e) =>
              typeof e === 'object' &&
              e !== null &&
              'code' in e &&
              e.code === '42501',
          );
      },
    );
    await t.test(
      'Delegation owner reads: exact issuer/sub and actor/target Membership columns do not expose another identity or directory',
      async () => {
        await delegation.transaction(async (manager) => {
          await manager.query(
            "SELECT set_config('innoview.oidc_issuer',$1,true),set_config('innoview.oidc_subject',$2,true),set_config('innoview.tenant_id',$3,true),set_config('innoview.user_identity_id',$4,true),set_config('innoview.delegation_target_membership',$5,true)",
            [
              principals[0].issuer,
              principals[0].subject,
              tenant,
              identities[0].id,
              memberships[1].membership.id,
            ],
          );
          assert.deepEqual(
            await manager.query('SELECT id FROM identity.user_identity'),
            [{ id: identities[0].id }],
          );
          assert.deepEqual(
            (
              await manager.query<{ id: string }[]>(
                'SELECT id FROM memberships.membership',
              )
            )
              .map((m) => m.id)
              .sort(),
            [memberships[0].membership.id, memberships[1].membership.id].sort(),
          );
          assert.deepEqual(
            await manager.query(
              'SELECT id FROM "authorization".role WHERE tenant_id=$1',
              [b.tenant.id],
            ),
            [],
          );
        });
      },
    );
    await t.test(
      'Delegation 10: foreign tenant/Membership and forged or substituted actor contracts fail closed',
      async () => {
        await reject(
          principals[0],
          request({ membershipId: foreign.membership.id }),
        );
        await reject(principals[0], request(), b.tenant.id);
        await reject({ ...principals[0] }, request());
        await assert.rejects(
          service.assign(principals[0], tenant, {
            ...request(),
            actor: identities[1].id,
          }),
        );
      },
    );
    await t.test(
      'Delegation bootstrap remains technical, explicit and idempotent; runtime cannot attribute USER_IDENTITY technically',
      async () => {
        assert.deepEqual(
          await auth.assign(
            tenant,
            memberships[0].membership.id,
            admin.id,
            scope,
            bootstrap,
            'GRANT_TENANT_ADMIN',
          ),
          initial,
        );
        await assert.rejects(async () =>
          auth.assign(
            tenant,
            memberships[0].membership.id,
            admin.id,
            scope,
            { ...op(), actorType: 'USER_IDENTITY' },
            'GRANT_TENANT_ADMIN',
          ),
        );
      },
    );
    await t.test(
      'Delegation 8: different administrators serialize with technical writers without losing revisions',
      async () => {
        const splitAuthority = await auth.createRole(
          tenant,
          'Split administrative capability',
          'Fixture',
          op(),
        );
        await auth.grantPermission(
          tenant,
          splitAuthority.id,
          'authorization.assignment.grant',
          op(),
        );
        await auth.assign(
          tenant,
          memberships[3].membership.id,
          ordinary.id,
          scope,
          op(),
        );
        await auth.assign(
          tenant,
          memberships[3].membership.id,
          splitAuthority.id,
          scope,
          { ...op(), actorType: 'INNOVIEW_OPERATOR' },
          'GRANT_TENANT_ADMIN',
        );
        const [revisionBefore] = await inspect<{ revision: string }[]>(
          'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1',
          [tenant],
        );
        await Promise.all([
          service.assign(
            principals[0],
            tenant,
            request({ membershipId: memberships[2].membership.id }),
          ),
          service.assign(
            principals[3],
            tenant,
            request({ membershipId: memberships[0].membership.id }),
          ),
          auth.createRole(tenant, 'Concurrent technical', 'Fixture', op()),
        ]);
        const [revisionAfter] = await inspect<{ revision: string }[]>(
          'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1',
          [tenant],
        );
        assert.equal(
          BigInt(revisionAfter.revision),
          BigInt(revisionBefore.revision) + 3n,
        );
      },
    );
    await t.test(
      'Delegation SQL: fixed actor context cannot cross tenant, forge ledger Membership or bypass containment',
      async () => {
        for (const value of [
          request({ roleId: excess.id }),
          request({ roleId: admin.id }),
        ]) {
          const runner = await raw(value);
          try {
            await assert.rejects(
              insertRaw(runner, value),
              (e) =>
                typeof e === 'object' &&
                e !== null &&
                'code' in e &&
                e.code === '42501',
            );
          } finally {
            await rollback(runner);
          }
        }
        const value = request(),
          runner = await raw(value);
        try {
          assert.deepEqual(
            await runner.query(
              'SELECT id FROM "authorization".role WHERE tenant_id=$1',
              [b.tenant.id],
            ),
            [],
          );
          assert.deepEqual(
            await runner.query(
              'SELECT id FROM memberships.membership WHERE tenant_id=$1',
              [b.tenant.id],
            ),
            [],
          );
          await runner.query(
            "SELECT set_config('innoview.delegation_actor_membership',$1,true)",
            [memberships[1].membership.id],
          );
          await assert.rejects(insertRaw(runner, value));
        } finally {
          await rollback(runner);
        }
      },
    );
    await t.test(
      'Delegation unit change: external Organizations commit before deferred recheck aborts all assignment effects',
      async () => {
        const candidateRole = await auth.createRole(
          tenant,
          'Deferred unit reader',
          'Fixture',
          op(),
        );
        await auth.grantPermission(
          tenant,
          candidateRole.id,
          'foundation.probe.read',
          op(),
        );
        const value = request({ roleId: candidateRole.id }),
          runner = await raw(value);
        try {
          await insertRaw(runner, value);
          await runner.query(
            'UPDATE "authorization".operation SET result=\'{}\',completed_at=clock_timestamp() WHERE request_id=$1',
            [value.requestId],
          );
          // Owner-controlled direct SQL: no cross-module writer lock is held by delegation.
          await orgSource.transaction(async (manager) => {
            const change = op();
            await establishOperationContext(
              manager,
              'organizations',
              change,
              tenant,
            );
            await manager.query(
              `INSERT INTO organizations.operation(request_id,tenant_id,operation_type,fingerprint,actor,actor_type,reason,technical_source) VALUES($1,$2,'SET_STATUS',$3,$4,$5,$6,'fixture:concurrent-unit')`,
              [
                change.requestId,
                tenant,
                '0'.repeat(64),
                change.actor,
                change.actorType,
                change.reason,
              ],
            );
            await manager.query(
              "UPDATE organizations.organizational_unit SET status='INACTIVE' WHERE tenant_id=$1 AND id=$2",
              [tenant, scope.unitId],
            );
            await manager.query(
              "UPDATE organizations.operation SET result='{}',completed_at=clock_timestamp() WHERE request_id=$1",
              [change.requestId],
            );
          });
          await assert.rejects(
            runner.commitTransaction(),
            (e) =>
              typeof e === 'object' &&
              e !== null &&
              'code' in e &&
              e.code === '42501',
          );
        } finally {
          await rollback(runner);
        }
        assert.deepEqual(
          await inspect(
            'SELECT request_id FROM "authorization".operation WHERE request_id=$1',
            [value.requestId],
          ),
          [],
        );
        assert.deepEqual(
          await inspect(
            'SELECT id FROM "authorization".audit_event WHERE operation_request_id=$1',
            [value.requestId],
          ),
          [],
        );
        await orgs.setStatus(tenant, scope.unitId, 'ACTIVE', op());
      },
    );
    await t.test(
      'Delegation concurrent Role change: technical writer waits for revision, then the next assignment observes INACTIVE',
      async () => {
        const candidateRole = await auth.createRole(
          tenant,
          'Concurrent role lifecycle',
          'Fixture',
          op(),
        );
        await auth.grantPermission(
          tenant,
          candidateRole.id,
          'foundation.probe.read',
          op(),
        );
        const value = request({ roleId: candidateRole.id }),
          runner = await raw(value);
        let pending: Promise<unknown> | undefined;
        try {
          await insertRaw(runner, value);
          await runner.query(
            'UPDATE "authorization".operation SET result=\'{}\',completed_at=clock_timestamp() WHERE request_id=$1',
            [value.requestId],
          );
          let settled = false;
          pending = auth
            .setRoleStatus(tenant, candidateRole.id, 'INACTIVE', op())
            .finally(() => {
              settled = true;
            });
          await pause(100);
          assert.equal(
            settled,
            false,
            'Technical writer cannot bypass the same tenant revision lock',
          );
          await runner.commitTransaction();
          await pending;
          await reject(
            principals[0],
            request({
              roleId: candidateRole.id,
              membershipId: memberships[0].membership.id,
            }),
          );
        } finally {
          await rollback(runner);
          await pending;
        }
      },
    );
    await t.test(
      'Delegation administrative revocation in flight: real backend waits on tenant revision, then future requests deny',
      async () => {
        const candidateRole = await auth.createRole(
          tenant,
          'In-flight authority revocation',
          'Fixture',
          op(),
        );
        await auth.grantPermission(
          tenant,
          candidateRole.id,
          'foundation.probe.read',
          op(),
        );
        const value = request({ roleId: candidateRole.id }),
          runner = await raw(value);
        const revocationSource = createDataSource('authorization', env);
        revocationSource.setOptions({ poolSize: 1 });
        await revocationSource.initialize();
        let pending: Promise<unknown> | undefined;
        try {
          await insertRaw(runner, value);
          await runner.query(
            'UPDATE "authorization".operation SET result=\'{}\',completed_at=clock_timestamp() WHERE request_id=$1',
            [value.requestId],
          );
          const [backend] = await revocationSource.query<{ pid: number }[]>(
            'SELECT pg_backend_pid() AS pid',
          );
          pending = new AuthorizationService(revocationSource).revokeAssignment(
            tenant,
            initial.id,
            op(),
          );
          let blocked = false;
          for (let attempt = 0; attempt < 80; attempt++) {
            const [state] = await migrator.query<{ blocked: boolean }[]>(
              'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',
              [backend.pid],
            );
            if (state.blocked) {
              blocked = true;
              break;
            }
            await pause(25);
          }
          assert.equal(
            blocked,
            true,
            'Actual technical backend must wait on the delegated tenant revision',
          );
          await runner.commitTransaction();
          await pending;
          await reject(
            principals[0],
            request({
              membershipId: memberships[3].membership.id,
              roleId: candidateRole.id,
            }),
          );
        } finally {
          await rollback(runner);
          await pending;
          await revocationSource.destroy();
        }
      },
    );
    await t.test(
      'Delegation revoked target denies; actor revocation prevents new writes and historical replay, never reexecutes',
      async () => {
        await members.revoke(tenant, identities[2].id, op());
        await reject(
          principals[3],
          request({ membershipId: memberships[2].membership.id }),
        );
        await auth.revokeAssignment(tenant, initial.id, op());
        await reject(principals[0], successful);
        await reject();
        const [count] = await inspect<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM "authorization".audit_event WHERE operation_request_id=$1',
          [successful.requestId],
        );
        assert.equal(count.n, 1);
      },
    );
    await t.test(
      'Delegation 7/14: actor Membership revoked and committed in flight makes deferred commit fail atomically',
      async () => {
        const candidateRole = await auth.createRole(
          tenant,
          'Deferred membership reader',
          'Fixture',
          op(),
        );
        await auth.grantPermission(
          tenant,
          candidateRole.id,
          'foundation.probe.read',
          op(),
        );
        const value = request({ roleId: candidateRole.id }),
          runner = await raw(value, 3);
        const [before] = await inspect<{ revision: string }[]>(
          'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1',
          [tenant],
        );
        try {
          await insertRaw(runner, value);
          await runner.query(
            'UPDATE "authorization".operation SET result=\'{}\',completed_at=clock_timestamp() WHERE request_id=$1',
            [value.requestId],
          );
          await members.revoke(tenant, identities[3].id, op());
          await assert.rejects(
            runner.commitTransaction(),
            (e) =>
              typeof e === 'object' &&
              e !== null &&
              'code' in e &&
              e.code === '42501',
          );
        } finally {
          await rollback(runner);
        }
        assert.deepEqual(
          await inspect(
            'SELECT request_id FROM "authorization".operation WHERE request_id=$1',
            [value.requestId],
          ),
          [],
        );
        assert.deepEqual(
          await inspect(
            'SELECT id FROM "authorization".audit_event WHERE operation_request_id=$1',
            [value.requestId],
          ),
          [],
        );
        assert.deepEqual(
          await inspect(
            'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1',
            [tenant],
          ),
          [before],
        );
      },
    );
    await t.test(
      'Delegation H4 SQL: inconsistent human Membership/Identity rejected by the composite FK',
      async () => {
        await assert.rejects(
          delegation.transaction(async (manager) => {
            const value = request(),
              human = delegatedOperation(
                identities[0].id,
                memberships[1].membership.id,
                value,
              );
            await establishOperationLocals(
              manager,
              'authorization',
              human,
              tenant,
            );
            await manager.query(
              "SELECT set_config('innoview.user_identity_id',$1,true),set_config('innoview.delegation_actor_membership',$2,true)",
              [human.actor, human.actorMembershipId],
            );
            await manager.query(
              `INSERT INTO "authorization".operation(request_id,tenant_id,operation_type,fingerprint,fingerprint_version,actor,actor_type,reason,technical_source,actor_membership_id,actor_user_identity_id) VALUES($1,$2,'DELEGATED_ASSIGN',$3,2,$4::text,'USER_IDENTITY',$5,'fixture:invalid-human',$6,$4::uuid)`,
              [
                human.requestId,
                tenant,
                '0'.repeat(64),
                human.actor,
                human.reason,
                human.actorMembershipId,
              ],
            );
          }),
          (e) =>
            typeof e === 'object' &&
            e !== null &&
            'code' in e &&
            e.code === '23503',
        );
      },
    );
    await t.test(
      'Delegation diagnostics detect new-role column grants, owner boundary drift and disabled deferred enforcement',
      async () => {
        const quoted = '"' + env.DB_AUTHORIZATION_DELEGATION_USER! + '"';
        await migrator.query(
          `GRANT UPDATE(status) ON "authorization".role TO ${quoted}`,
        );
        try {
          assert.ok(
            (await securityInvariants(diagnostic)).findings.some((f) =>
              f.startsWith(
                'COLUMN_ACL:authorization_delegation:authorization.role:status:UPDATE',
              ),
            ),
          );
        } finally {
          await migrator.query(
            `REVOKE UPDATE(status) ON "authorization".role FROM ${quoted}`,
          );
        }
        const [policy] = await migrator.query<{ qual: string }[]>(
          "SELECT qual FROM pg_policies WHERE schemaname='memberships' AND tablename='membership' AND policyname='delegation_boundary'",
        );
        await migrator.query(
          'ALTER POLICY delegation_boundary ON memberships.membership USING(true)',
        );
        try {
          assert.ok(
            (await securityInvariants(diagnostic)).findings.includes(
              'DELEGATION_READ_BOUNDARY:memberships.membership:boundary',
            ),
          );
        } finally {
          await migrator.query(
            `ALTER POLICY delegation_boundary ON memberships.membership USING(${policy.qual})`,
          );
        }
        await migrator.query(
          'ALTER TABLE "authorization".role_assignment DISABLE TRIGGER delegated_authority_commit',
        );
        try {
          assert.ok(
            (await securityInvariants(diagnostic)).findings.includes(
              'DELEGATION_TRIGGER_CONTRACT',
            ),
          );
        } finally {
          await migrator.query(
            'ALTER TABLE "authorization".role_assignment ENABLE TRIGGER delegated_authority_commit',
          );
        }
      },
    );
    await t.test(
      'Delegation 15: deprecated administrative permission never counts as authority (terminal catalog fixture)',
      async () => {
        const fresh = await verifiedPrincipal(),
          identity = await ids.resolve(fresh),
          membership = await members.register(tenant, identity.id, op());
        await auth.assign(
          tenant,
          membership.membership.id,
          admin.id,
          scope,
          { ...op(), actorType: 'INNOVIEW_OPERATOR' },
          'GRANT_TENANT_ADMIN',
        );
        await migrator.query(
          "UPDATE \"authorization\".permission SET status='DEPRECATED' WHERE code='authorization.assignment.grant'",
        );
        await reject(
          fresh,
          request({ membershipId: membership.membership.id }),
        );
      },
    );
    await t.test(
      'Delegation LOCAL cleanup, strict ACL/RLS inventory and rollback protection preserve history',
      async () => {
        assert.deepEqual(
          await delegation.query(
            'SELECT id FROM "authorization".role_assignment',
          ),
          [],
        );
        assert.deepEqual((await securityInvariants(diagnostic)).findings, []);
        await assert.rejects(migrator.undoLastMigration(), /forward migration/);
      },
    );
  } finally {
    await Promise.allSettled(
      [delegation, technical, memberSource, orgSource, diagnostic].map((s) =>
        s.destroy(),
      ),
    );
  }
}
