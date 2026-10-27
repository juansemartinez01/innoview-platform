import { organizationsFixture } from '../organizations/organizations-fixture.spec.js';
import {
  verifiedPrincipal,
  invalidPrincipalFixture,
} from '../authentication/verified-fixture.spec.js';
import { organizationOperation } from '../operations/fixtures.spec.js';
import { initializeOrganizationsOperatorDataSource } from '../persistence/data-sources.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { DataSource, EntityManager } from 'typeorm';
import pg from 'pg';
import {
  IdentityService,
  IdentityReadTransactions,
} from '../identity/identity.module.js';
import {
  createDataSource,
  initializeMembershipOperatorDataSource,
} from '../persistence/data-sources.js';
import { provisionDatabase } from '../persistence/provision.js';
import type { Environment } from '../persistence/connection.config.js';
import { MembershipsService } from './memberships.service.js';

function sqlState(error: unknown, ...codes: string[]) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  );
}
// Real RLS identity-isolation tests, not enterprise authorization or tenant RLS.
export async function verifyMembershipRls(
  t: TestContext,
  app: DataSource,
  migrator: DataSource,
  env: Environment,
) {
  const operator = await initializeMembershipOperatorDataSource(env);
  const organizationOperator =
    await initializeOrganizationsOperatorDataSource(env);
  const single = createDataSource('app', env);
  single.setOptions({ poolSize: 1 });
  await single.initialize();
  try {
    const identities = new IdentityService(app);
    const organizations = await organizationsFixture(organizationOperator, env);
    const writes = new MembershipsService(operator);
    const reads = new MembershipsService(app);
    const scoped = new IdentityReadTransactions(app, identities);
    const serial = new IdentityReadTransactions(
      single,
      new IdentityService(single),
    );
    const a = await verifiedPrincipal();
    const b = await verifiedPrincipal();
    const empty = await verifiedPrincipal();
    const idA = (await identities.resolve(a)).id;
    const idB = (await identities.resolve(b)).id;
    const idEmpty = (await identities.resolve(empty)).id;
    await t.test(
      'Principal provenance: verified original admitted, literal and spread clones rejected before acquiring a transaction',
      async () => {
        let called = false;
        for (const forged of [
          { issuer: a.issuer, subject: a.subject, clientId: a.clientId },
          { ...a },
        ]) {
          assert.equal(
            await scoped.read(forged, () => {
              called = true;
              return Promise.resolve();
            }),
            null,
          );
        }
        assert.equal(called, false);
        assert.equal(
          await scoped.read(a, (_manager, id) => Promise.resolve(id)),
          idA,
        );
        await assert.rejects(
          invalidPrincipalFixture({ issuer: 'https://foreign.invalid' }),
        );
        await assert.rejects(
          invalidPrincipalFixture({ audience: 'foreign-api' }),
        );
      },
    );
    const tenants = await Promise.all(
      ['RLS A', 'RLS A second', 'RLS B', 'RLS rollback'].map((name) =>
        organizations.createTenant(
          name,
          `${name} group`,
          organizationOperation(),
        ),
      ),
    );
    const op = () => ({
      actor: 'fixture:rls-operator',
      reason: 'Discardable RLS verification',
      requestId: randomUUID(),
    });
    await writes.register(tenants[0].tenant.id, idA, op());
    await writes.register(tenants[1].tenant.id, idA, op());
    await writes.register(tenants[2].tenant.id, idB, op());
    const own = (
      rows: { user_identity_id: string }[],
      id: string,
      count: number,
    ) => {
      assert.equal(rows.length, count);
      assert.ok(rows.every((row) => row.user_identity_id === id));
    };
    const all = (manager: EntityManager) =>
      manager.query<{ user_identity_id: string }[]>(
        'SELECT user_identity_id FROM memberships.membership ORDER BY id',
      );
    async function noResidue() {
      const [row] = await single.query<
        { pid: number; context: string | null; visible: number }[]
      >(
        "SELECT pg_backend_pid() AS pid,current_setting('innoview.user_identity_id',true) AS context,(SELECT count(*)::int FROM memberships.membership) AS visible",
      );
      assert.ok(!row.context);
      assert.equal(row.visible, 0);
      return row.pid;
    }
    await t.test(
      'RLS: ENABLE/FORCE, actor-specific policies and unchanged restricted privileges',
      async () => {
        const [table] = await migrator.query<
          {
            relrowsecurity: boolean;
            relforcerowsecurity: boolean;
            owner: string;
          }[]
        >(
          "SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='memberships.membership'::regclass",
        );
        assert.deepEqual(table, {
          relrowsecurity: true,
          relforcerowsecurity: true,
          owner: env.DB_MIGRATOR_USER,
        });
        const policies = await migrator.query<
          {
            policyname: string;
            roles: string[];
            cmd: string;
            permissive: string;
          }[]
        >(
          "SELECT policyname,roles::text[] AS roles,cmd,permissive FROM pg_policies WHERE schemaname='memberships' AND tablename='membership'",
        );
        assert.equal(policies.length, 7);
        assert.ok(
          policies.every(
            (p) => p.roles.length === 1 && !p.roles.includes('public'),
          ),
        );
        assert.equal(
          policies.filter((p) => p.roles.includes(env.DB_APP_USER!)).length,
          2,
        );
        assert.deepEqual(
          policies
            .filter((p) => p.roles.includes(env.DB_MEMBERSHIP_USER!))
            .map((p) => p.cmd)
            .sort(),
          ['INSERT', 'SELECT', 'UPDATE'],
        );
        for (const name of [
          env.DB_APP_USER!,
          env.DB_MEMBERSHIP_USER!,
          env.DB_MIGRATOR_USER!,
        ]) {
          const [role] = await migrator.query<{ unsafe: boolean }[]>(
            'SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS unsafe FROM pg_roles r WHERE rolname=$1',
            [name],
          );
          assert.equal(role.unsafe, false);
        }
        const [rights] = await app.query<
          { insert: boolean; update: boolean; delete: boolean }[]
        >(
          "SELECT has_table_privilege(current_user,'memberships.membership','INSERT') AS insert,has_any_column_privilege(current_user,'memberships.membership','UPDATE') AS update,has_table_privilege(current_user,'memberships.membership','DELETE') AS delete",
        );
        assert.deepEqual(rights, {
          insert: false,
          update: false,
          delete: false,
        });
        assert.deepEqual(
          await migrator.query('SELECT * FROM memberships.membership'),
          [],
          'FORCE also subjects the table owner to default deny',
        );
        const business = await migrator.query<{ relrowsecurity: boolean }[]>(
          "SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='organizations' AND c.relkind='r' AND c.relname<>'audit_event'",
        );
        assert.ok(business.every((r) => r.relrowsecurity));
        const definers = await migrator.query<{ present: number }[]>(
          "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='memberships' AND p.prosecdef",
        );
        assert.equal(definers.length, 0);
      },
    );
    await t.test(
      'RLS: absent, empty, malformed and nonexistent contexts expose zero rows without UUID conversion errors',
      async () => {
        assert.deepEqual(
          await app.query('SELECT * FROM memberships.membership'),
          [],
        );
        assert.deepEqual(await reads.listForIdentity(idA), []);
        for (const value of [
          '',
          ' ',
          'invalid-uuid',
          idA + '-suffix',
          `${idA}' OR true --`,
          '{"identity":"spoof"}',
          randomUUID(),
          idEmpty,
        ]) {
          await app.transaction(async (manager) => {
            await manager.query(
              "SELECT set_config('innoview.user_identity_id',$1,true)",
              [value],
            );
            assert.deepEqual(await all(manager), []);
          });
        }
      },
    );
    await t.test(
      'RLS: direct unfiltered SQL and joins expose only the scoped identity, across multiple tenants',
      async () => {
        await scoped.read(a, async (manager, id) => {
          assert.equal(id, idA);
          own(await all(manager), idA, 2);
          assert.deepEqual(
            await manager.query(
              'SELECT * FROM memberships.membership WHERE user_identity_id=$1 OR user_identity_id=$2',
              [idB, idEmpty],
            ),
            [],
          );
          const joined = await manager.query<{ user_identity_id: string }[]>(
            'SELECT m.user_identity_id FROM memberships.membership m JOIN identity.user_identity i ON i.id=m.user_identity_id WHERE true OR m.user_identity_id=$1',
            [idB],
          );
          own(joined, idA, 2);
          assert.deepEqual(await reads.listForIdentity(idB, manager), []);
          assert.equal(
            await reads.isActive(tenants[2].tenant.id, idB, manager),
            false,
          );
        });
        await scoped.read(b, async (manager) =>
          own(await all(manager), idB, 1),
        );
        await scoped.read(empty, async (manager) =>
          assert.deepEqual(await all(manager), []),
        );
        let called = false;
        assert.equal(
          await scoped.read(await verifiedPrincipal(), () => {
            called = true;
            return Promise.resolve(true);
          }),
          null,
        );
        assert.equal(
          await scoped.read({ ...a, subject: '' }, () => {
            called = true;
            return Promise.resolve(true);
          }),
          null,
        );
        assert.equal(called, false);
      },
    );
    await t.test(
      'RLS: commit, rollback and consecutive identities reuse the same backend without leaking LOCAL context',
      async () => {
        const pids = new Set<number>([await noResidue()]);
        for (const principal of [a, b, empty, a, b]) {
          const rows = await serial.read(principal, async (manager, id) => {
            const [pid] = await manager.query<{ pid: number }[]>(
              'SELECT pg_backend_pid() AS pid',
            );
            pids.add(pid.pid);
            const result = await all(manager);
            own(result, id, id === idA ? 2 : id === idB ? 1 : 0);
            return result;
          });
          assert.ok(rows);
          pids.add(await noResidue());
        }
        await assert.rejects(
          serial.read(a, async (manager) => {
            own(await all(manager), idA, 2);
            throw new Error('Intentional fixture rollback');
          }),
          /Intentional fixture rollback/,
        );
        pids.add(await noResidue());
        await serial.read(b, async (manager) =>
          own(await all(manager), idB, 1),
        );
        pids.add(await noResidue());
        assert.equal(
          pids.size,
          1,
          'A pool of one proves actual connection reuse, not fresh connections',
        );
        await assert.rejects(
          single.transaction(async (manager) => {
            await manager.query(
              "SELECT set_config('innoview.user_identity_id',$1,true)",
              [idA],
            );
            await manager.query('SET LOCAL row_security=off');
            await all(manager);
          }),
          (error) => sqlState(error, '42501'),
        );
        await noResidue();
      },
    );
    await t.test(
      'RLS: concurrent identity-scoped transactions on the real application pool never mix identities',
      async () => {
        const result = await Promise.all(
          Array.from({ length: 36 }, (_, i) => {
            const principal = i % 3 === 0 ? a : i % 3 === 1 ? b : empty;
            return scoped.read(principal, async (manager, id) => {
              await manager.query('SELECT pg_sleep(0.01)');
              own(await all(manager), id, id === idA ? 2 : id === idB ? 1 : 0);
              return id;
            });
          }),
        );
        assert.equal(result.length, 36);
        assert.deepEqual(
          await app.query('SELECT * FROM memberships.membership'),
          [],
        );
      },
    );
    await t.test(
      'RLS: restrictive boundary survives an additional permissive SELECT policy; application cannot change policy or write',
      async () => {
        await migrator.query(
          `CREATE POLICY fixture_permissive ON memberships.membership FOR SELECT TO ${pg.escapeIdentifier(env.DB_APP_USER!)} USING(true)`,
        );
        try {
          assert.deepEqual(
            await app.query('SELECT * FROM memberships.membership'),
            [],
          );
          await scoped.read(a, async (manager) => {
            own(await all(manager), idA, 2);
          });
          for (const sql of [
            "UPDATE memberships.membership SET status='REVOKED'",
            'DELETE FROM memberships.membership',
            'TRUNCATE memberships.membership',
            'ALTER TABLE memberships.membership DISABLE ROW LEVEL SECURITY',
            `SET ROLE ${pg.escapeIdentifier(env.DB_MEMBERSHIP_USER!)}`,
          ])
            await assert.rejects(
              app.transaction(async (manager) => {
                await manager.query(
                  "SELECT set_config('innoview.user_identity_id',$1,true)",
                  [idA],
                );
                await manager.query(sql);
              }),
              (error) => sqlState(error, '42501'),
            );
        } finally {
          await migrator.query(
            'DROP POLICY fixture_permissive ON memberships.membership',
          );
        }
      },
    );
    await t.test(
      'RLS: operator reads complete history and revokes with atomic audit; application retains own history but no active membership',
      async () => {
        const changed = await writes.revoke(tenants[0].tenant.id, idA, op());
        assert.equal(changed.changed, true);
        const repeated = await writes.revoke(tenants[0].tenant.id, idA, op());
        assert.equal(repeated.changed, false);
        assert.equal(changed.auditEventId, repeated.auditEventId);
        await scoped.read(a, async (manager) => {
          own(await all(manager), idA, 2);
          assert.equal(
            await reads.isActive(tenants[0].tenant.id, idA, manager),
            false,
          );
          assert.equal(
            (await reads.listActiveForIdentity(idA, manager)).length,
            1,
          );
        });
        await assert.rejects(
          writes.register(tenants[0].tenant.id, idA, op()),
          (error) => sqlState(error, 'REVOKED_TERMINAL'),
        );
        const audit = await operator.query<{ id: string }[]>(
          'SELECT id FROM memberships.audit_event WHERE membership_id=$1 AND event_type=$2',
          [changed.membership.id, 'REVOKED'],
        );
        assert.equal(audit.length, 1);
      },
    );
    await t.test(
      'RLS: a policy rejection rolls back earlier membership and audit writes in the same operator transaction',
      async () => {
        const target = tenants[3].tenant.id;
        await migrator.query(
          `CREATE POLICY fixture_operator_limit ON memberships.membership AS RESTRICTIVE FOR INSERT TO ${pg.escapeIdentifier(env.DB_MEMBERSHIP_USER!)} WITH CHECK(user_identity_id<>${pg.escapeLiteral(idB)}::uuid)`,
        );
        try {
          await assert.rejects(
            operator.transaction(async (manager) => {
              for (const identityId of [idA, idB]) {
                const operation = op();
                await manager.query(
                  "SELECT set_config('innoview.membership_actor',$1,true),set_config('innoview.membership_reason',$2,true),set_config('innoview.membership_source','TRUSTED',true),set_config('innoview.membership_request',$3,true)",
                  [operation.actor, operation.reason, operation.requestId],
                );
                await manager.query(
                  'INSERT INTO memberships.membership(tenant_id,user_identity_id) VALUES($1,$2)',
                  [target, identityId],
                );
              }
            }),
            (error) => sqlState(error, '42501'),
          );
          assert.deepEqual(
            await operator.query(
              'SELECT * FROM memberships.membership WHERE tenant_id=$1',
              [target],
            ),
            [],
          );
          assert.deepEqual(
            await operator.query(
              'SELECT * FROM memberships.audit_event WHERE tenant_id=$1',
              [target],
            ),
            [],
          );
        } finally {
          await migrator.query(
            'DROP POLICY fixture_operator_limit ON memberships.membership',
          );
        }
        const initial = await writes.bootstrapFirst(target, idA, op());
        const repeat = await writes.bootstrapFirst(target, idA, op());
        assert.equal(initial.changed, true);
        assert.equal(repeat.changed, false);
        assert.equal(initial.auditEventId, repeat.auditEventId);
      },
    );
    await t.test(
      'RLS: global FK/unique integrity remains effective despite hidden rows and provisioning keeps the policies',
      async () => {
        assert.deepEqual(
          await migrator.query('SELECT * FROM memberships.membership'),
          [],
        );
        await assert.rejects(
          migrator.query('DELETE FROM identity.user_identity WHERE id=$1', [
            idB,
          ]),
          (error) => sqlState(error, '23001', '23503'),
        );
        await provisionDatabase(env);
        await provisionDatabase(env);
        assert.deepEqual(
          await app.query('SELECT * FROM memberships.membership'),
          [],
        );
        await scoped.read(b, async (manager) =>
          own(await all(manager), idB, 1),
        );
        const [count] = await operator.query<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM memberships.membership WHERE user_identity_id IN($1,$2)',
          [idA, idB],
        );
        assert.equal(count.n, 4);
      },
    );
  } finally {
    await single.destroy();
    await organizationOperator.destroy();
    await operator.destroy();
  }
}
