import { organizationsFixture } from '../organizations/organizations-fixture.spec.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { DataSource, EntityManager } from 'typeorm';
import {
  AuthorizationService,
  AuthorizationOperationError,
} from './authorization.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import { IdentityService } from '../identity/identity.module.js';
import { organizationOperation } from '../operations/fixtures.spec.js';
import {
  establishOperationContext,
  TrustedOperationTransientError,
} from '../operations/operation-context.js';
import {
  createDataSource,
  initializeAuthorizationOperatorDataSource,
  initializeMembershipOperatorDataSource,
  initializeOrganizationsOperatorDataSource,
} from '../persistence/data-sources.js';
import type { Environment } from '../persistence/connection.config.js';

function gate() {
  let open!: () => void;
  const entered = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { entered, open };
}
export async function verifyAuthorizationPreparation(
  t: TestContext,
  app: DataSource,
  migrator: DataSource,
  env: Environment,
) {
  const auth = await initializeAuthorizationOperatorDataSource(env),
    member = await initializeMembershipOperatorDataSource(env),
    org = await initializeOrganizationsOperatorDataSource(env);
  const memberships = new MembershipsService(member),
    organizations = await organizationsFixture(org, env);
  const references = {
    membershipActive: (tenant: string, id: string) =>
      memberships.activeMembershipReference(tenant, id),
    scopeAvailable: (
      tenant: string,
      id: string,
      type: 'GROUP' | 'COMPANY' | 'BRANCH',
    ) => organizations.availableScopeReference(tenant, id, type),
  };
  const service = new AuthorizationService(auth, references);
  const fixture = async () => {
    const tenant = await organizations.createTenant(
      'Preparation fixture',
      'Preparation group',
      organizationOperation(),
    );
    const company = await organizations.createCompany(
      tenant.tenant.id,
      tenant.group.id,
      'Preparation company',
      null,
      organizationOperation(),
    );
    const identity = await new IdentityService(app).resolve({
      issuer: 'https://preparation.invalid',
      subject: randomUUID(),
      clientId: 'innoview-portal',
    });
    const membership = await memberships.register(
      tenant.tenant.id,
      identity.id,
      organizationOperation(),
    );
    const role = await service.createRole(
      tenant.tenant.id,
      'Preparation role',
      'Fixture',
      organizationOperation(),
    );
    const args = [
      tenant.tenant.id,
      membership.membership.id,
      role.id,
      { type: 'COMPANY' as const, unitId: company.company.id },
    ] as const;
    return {
      tenant: tenant.tenant.id,
      identity: identity.id,
      role: role.id,
      unit: company.company.id,
      args,
    };
  };
  const read = <T>(tenant: string, action: (m: EntityManager) => Promise<T>) =>
    auth.transaction(async (m) => {
      await m.query('SET TRANSACTION READ ONLY');
      await establishOperationContext(
        m,
        'authorization',
        organizationOperation(),
        tenant,
      );
      return action(m);
    });
  const noRecords = async (tenant: string, request: string) =>
    read(tenant, async (m) => {
      assert.deepEqual(
        await m.query(
          'SELECT request_id FROM "authorization".operation WHERE request_id=$1',
          [request],
        ),
        [],
      );
      assert.deepEqual(
        await m.query(
          'SELECT id FROM "authorization".audit_event WHERE operation_request_id=$1',
          [request],
        ),
        [],
      );
    });
  try {
    await t.test(
      'Preparation: committed replay survives revoked membership, inactive unit/role/tenant; incompatible envelopes still conflict',
      async () => {
        const f = await fixture(),
          op = organizationOperation(),
          result = await service.assign(...f.args, op);
        await memberships.revoke(f.tenant, f.identity, organizationOperation());
        assert.deepEqual(await service.assign(...f.args, op), result);
        await organizations.setStatus(
          f.tenant,
          f.unit,
          'INACTIVE',
          organizationOperation(),
        );
        assert.deepEqual(await service.assign(...f.args, op), result);
        await organizations.setStatus(
          f.tenant,
          f.unit,
          'ARCHIVED',
          organizationOperation(),
        );
        assert.deepEqual(await service.assign(...f.args, op), result);
        await service.setRoleStatus(
          f.tenant,
          f.role,
          'INACTIVE',
          organizationOperation(),
        );
        await organizations.setStatus(
          f.tenant,
          null,
          'INACTIVE',
          organizationOperation(),
        );
        assert.deepEqual(await service.assign(...f.args, op), result);
        await assert.rejects(
          service.createRole(
            f.tenant,
            'Preparation role',
            'Name remains reserved',
            organizationOperation(),
          ),
          AuthorizationOperationError,
        );
        for (const invoke of [
          () =>
            service.assign(...f.args, { ...op, actor: 'other:trusted-actor' }),
          () =>
            service.assign(
              f.tenant,
              f.args[1],
              f.role,
              { type: 'GROUP', unitId: f.unit },
              op,
            ),
          () =>
            service.createRole(f.tenant, 'Different operation', 'Fixture', op),
          () => service.assign(randomUUID(), f.args[1], f.role, f.args[3], op),
        ])
          await assert.rejects(
            invoke(),
            (error) =>
              error instanceof AuthorizationOperationError &&
              error.code === 'REQUEST_ID_CONFLICT',
          );
        const invalid = organizationOperation();
        await assert.rejects(
          service.assign(...f.args, invalid),
          (error) =>
            error instanceof AuthorizationOperationError &&
            error.code === 'REFERENCE_UNAVAILABLE',
        );
        await noRecords(f.tenant, invalid.requestId);
        const availableMember = await fixture(),
          unitOperation = organizationOperation();
        const unitResult = await service.assign(
          ...availableMember.args,
          unitOperation,
        );
        await organizations.setStatus(
          availableMember.tenant,
          availableMember.unit,
          'INACTIVE',
          organizationOperation(),
        );
        assert.deepEqual(
          await service.assign(...availableMember.args, unitOperation),
          unitResult,
        );
        const replayWithoutOwners = new AuthorizationService(auth, {
          membershipActive: () =>
            assert.fail('Completed replay must not call Memberships'),
          scopeAvailable: () =>
            assert.fail('Completed replay must not call Organizations'),
        });
        assert.deepEqual(
          await replayWithoutOwners.assign(
            ...availableMember.args,
            unitOperation,
          ),
          unitResult,
        );
      },
    );
    await t.test(
      'Preparation: commit between precheck and failed owner validation returns the original replay',
      async () => {
        const f = await fixture(),
          entered = gate(),
          release = gate(),
          op = organizationOperation();
        const delayed = new AuthorizationService(auth, {
          ...references,
          membershipActive: async (tenant, id) => {
            entered.open();
            await release.entered;
            return references.membershipActive(tenant, id);
          },
        });
        const pending = delayed.assign(...f.args, op);
        try {
          await entered.entered;
          const result = await service.assign(...f.args, op);
          await memberships.revoke(
            f.tenant,
            f.identity,
            organizationOperation(),
          );
          release.open();
          assert.deepEqual(await pending, result);
        } finally {
          release.open();
          await pending.catch(() => undefined);
        }
      },
    );
    for (const purpose of ['membership', 'organizations'] as const)
      await t.test(
        `Preparation: saturated ${purpose} pool holds no Authorization transaction/revision lock and recovers atomically`,
        async () => {
          const f = await fixture(),
            small = createDataSource(purpose, env);
          small.setOptions({ poolSize: 1, connectTimeoutMS: 1500 });
          await small.initialize();
          const holder = small.createQueryRunner();
          await holder.connect();
          let validationFinished = false;
          const entered = gate(),
            op = organizationOperation();
          const ownMember = new MembershipsService(small),
            ownOrg = new OrganizationsService(small);
          const blockedService = new AuthorizationService(auth, {
            membershipActive: async (tenant, id) => {
              if (purpose === 'membership') {
                entered.open();
                return ownMember
                  .activeMembershipReference(tenant, id)
                  .finally(() => {
                    validationFinished = true;
                  });
              }
              return references.membershipActive(tenant, id);
            },
            scopeAvailable: async (tenant, id, type) => {
              if (purpose === 'organizations') {
                entered.open();
                return ownOrg
                  .availableScopeReference(tenant, id, type)
                  .finally(() => {
                    validationFinished = true;
                  });
              }
              return references.scopeAvailable(tenant, id, type);
            },
          });
          const pending = blockedService.assign(...f.args, op);
          const rejected = assert.rejects(
            pending,
            (error) =>
              error instanceof TrustedOperationTransientError &&
              error.code === 'POOL_ACQUISITION_TIMEOUT',
          );
          try {
            await entered.entered;
            assert.equal(validationFinished, false);
            await auth.transaction(async (m) => {
              await establishOperationContext(
                m,
                'authorization',
                organizationOperation(),
                f.tenant,
              );
              // NOWAIT is evidence, not a latency threshold: fails if assign holds it.
              await m.query(
                'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1 FOR UPDATE NOWAIT',
                [f.tenant],
              );
              const [state] = await m.query<{ n: number }[]>(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1 AND state='idle in transaction'",
                [env.DB_AUTHORIZATION_USER],
              );
              assert.equal(state.n, 0);
            });
            assert.equal(
              validationFinished,
              false,
              'Lock proof must run while the owner acquisition is still pending',
            );
            await rejected;
            await noRecords(f.tenant, op.requestId);
          } finally {
            await holder.release();
            await rejected.catch(() => undefined);
            await small.destroy();
          }
          const result = await service.assign(...f.args, op);
          assert.deepEqual(await service.assign(...f.args, op), result);
          const [state] = await auth.query<
            { tenant: string | null; request: string | null; lock: string }[]
          >(
            "SELECT NULLIF(current_setting('innoview.tenant_id',true),'') AS tenant,NULLIF(current_setting('innoview.authorization_request',true),'') AS request,current_setting('lock_timeout') AS lock",
          );
          assert.deepEqual(state, { tenant: null, request: null, lock: '1s' });
        },
      );
    await t.test(
      'Authorization timeout: inside own delayed writer is 8s, concurrent uncommitted replay survives revocation and resets to 1s',
      async () => {
        const f = await fixture(),
          op = organizationOperation();
        await migrator.query(
          `CREATE FUNCTION "authorization".fixture_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('innoview.authorization_request')='${op.requestId}' THEN IF current_setting('lock_timeout')<>'8s' THEN RAISE EXCEPTION 'Local timeout missing';END IF;PERFORM pg_sleep(1.6);END IF;RETURN NEW;END $$`,
        );
        await migrator.query(
          'CREATE TRIGGER fixture_delay AFTER INSERT ON "authorization".role_assignment FOR EACH ROW EXECUTE FUNCTION "authorization".fixture_delay()',
        );
        const first = service.assign(...f.args, op);
        try {
          // Wait for real PostgreSQL sleep: the first write is not committed yet.
          const deadline = Date.now() + 10000;
          while (true) {
            const [state] = await auth.query<{ sleeping: boolean }[]>(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='PgSleep') AS sleeping",
              [env.DB_AUTHORIZATION_USER],
            );
            if (state.sleeping) break;
            assert.ok(Date.now() < deadline, 'Delayed write did not start');
            await pause(10);
          }
          await memberships.revoke(
            f.tenant,
            f.identity,
            organizationOperation(),
          );
          const second = service.assign(...f.args, op);
          assert.deepEqual(await first, await second);
          await read(f.tenant, async (m) => {
            assert.equal(
              (
                await m.query<{ n: number }[]>(
                  'SELECT count(*)::int AS n FROM "authorization".audit_event WHERE operation_request_id=$1',
                  [op.requestId],
                )
              )[0].n,
              1,
            );
            assert.equal(
              (
                await m.query<{ n: number }[]>(
                  'SELECT count(*)::int AS n FROM "authorization".role_assignment WHERE membership_id=$1',
                  [f.args[1]],
                )
              )[0].n,
              1,
            );
          });
          const [state] = await auth.query<
            { lock: string; tenant: string | null }[]
          >(
            "SELECT current_setting('lock_timeout') AS lock,NULLIF(current_setting('innoview.tenant_id',true),'') AS tenant",
          );
          assert.deepEqual(state, { lock: '1s', tenant: null });
        } finally {
          await first.catch(() => undefined);
          await migrator.query(
            'DROP TRIGGER fixture_delay ON "authorization".role_assignment',
          );
          await migrator.query('DROP FUNCTION "authorization".fixture_delay()');
        }
      },
    );
  } finally {
    await auth.destroy();
    await member.destroy();
    await org.destroy();
  }
}
