import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import type { DataSource, EntityManager } from 'typeorm';
import pg from 'pg';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { IdentityService } from '../identity/identity.module.js';
import {
  initializeApplicationDataSource,
  initializeMembershipOperatorDataSource,
} from '../persistence/data-sources.js';
import { provisionDatabase } from '../persistence/provision.js';
import type { Environment } from '../persistence/connection.config.js';
import {
  MembershipsService,
  type MembershipOperation,
} from './memberships.service.js';

function state(error: unknown, ...codes: string[]) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  );
}
const context = (): MembershipOperation => ({
  actor: 'test:trusted-operator',
  reason: 'Disposable integration fixture',
  requestId: randomUUID(),
});

// Same disposable Foundation database; never production/development DB_NAME.
// These tests assert memberships and SQL permissions, NOT RLS tenant isolation.
export async function verifyMemberships(
  t: TestContext,
  app: DataSource,
  migrator: DataSource,
  env: Environment,
) {
  const operator = await initializeMembershipOperatorDataSource(env);
  try {
    const writes = new MembershipsService(operator);
    const reads = new MembershipsService(app);
    const organizations = new OrganizationsService(app);
    const identities = new IdentityService(app);
    const tenantA = (
      await organizations.createTenant('Membership fixture A', 'Group A')
    ).tenant.id;
    const tenantB = (
      await organizations.createTenant('Membership fixture B', 'Group B')
    ).tenant.id;
    const tenantC = (
      await organizations.createTenant(
        'Membership bootstrap fixture',
        'Group C',
      )
    ).tenant.id;
    const identityA = (
      await identities.resolve({
        issuer: 'https://fixture.invalid',
        subject: randomUUID(),
        clientId: 'test',
      })
    ).id;
    const identityB = (
      await identities.resolve({
        issuer: 'https://fixture.invalid',
        subject: randomUUID(),
        clientId: 'test',
      })
    ).id;
    async function raw(
      sql: string,
      params: unknown[] = [],
      source = 'TRUSTED',
    ) {
      return operator.transaction(async (m: EntityManager) => {
        const op = context();
        await m.query(
          "SELECT set_config('innoview.membership_actor',$1,true),set_config('innoview.membership_reason',$2,true),set_config('innoview.membership_request',$3,true),set_config('innoview.membership_source',$4,true)",
          [op.actor, op.reason, op.requestId, source],
        );
        return m.query<unknown>(sql, params);
      });
    }
    let membershipA = '';
    await t.test(
      'Memberships: many-to-many, active directory and idempotent concurrent creation',
      async () => {
        const requests = await Promise.all(
          Array.from({ length: 12 }, () =>
            writes.register(tenantA, identityA, context()),
          ),
        );
        assert.equal(new Set(requests.map((r) => r.membership.id)).size, 1);
        assert.equal(requests.filter((r) => r.changed).length, 1);
        assert.equal(new Set(requests.map((r) => r.auditEventId)).size, 1);
        membershipA = requests[0].membership.id;
        await writes.register(tenantA, identityB, context());
        await writes.register(tenantB, identityA, context());
        assert.equal((await reads.listActiveForIdentity(identityA)).length, 2);
        assert.equal((await reads.listActiveForIdentity(identityB)).length, 1);
        assert.equal(await reads.isActive(tenantA, identityA), true);
        assert.equal(await reads.isActive(tenantB, identityB), false);
        assert.deepEqual(await reads.listForIdentity(randomUUID()), []);
      },
    );
    await t.test(
      'Memberships: real unique pair, missing references, states and rollback without orphan audit',
      async () => {
        await assert.rejects(
          raw(
            'INSERT INTO memberships.membership(tenant_id,user_identity_id) VALUES($1,$2)',
            [tenantA, identityA],
          ),
          (e) => state(e, '23505'),
        );
        for (const pair of [
          [randomUUID(), identityA],
          [tenantA, randomUUID()],
        ]) {
          await assert.rejects(
            writes.register(pair[0], pair[1], context()),
            (e) => state(e, 'INVALID_REFERENCE'),
          );
          await assert.rejects(
            raw(
              'INSERT INTO memberships.membership(tenant_id,user_identity_id) VALUES($1,$2)',
              pair,
            ),
            (e) => state(e, '23503'),
          );
        }
        await assert.rejects(
          raw(
            "INSERT INTO memberships.membership(tenant_id,user_identity_id,status) VALUES($1,$2,'INACTIVE')",
            [tenantB, identityB],
          ),
          (e) => state(e, '23514'),
        );
        const [counts] = await operator.query<
          { members: number; events: number }[]
        >(
          'SELECT (SELECT count(*)::int FROM memberships.membership) AS members,(SELECT count(*)::int FROM memberships.audit_event) AS events',
        );
        assert.deepEqual(counts, { members: 3, events: 3 });
      },
    );
    await t.test(
      'Memberships: revocation is terminal, repeated concurrent revokes preserve first audit and subsequent reads reject it',
      async () => {
        const before = (await reads.listForIdentity(identityA)).find(
          (m) => m.id === membershipA,
        )!;
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            writes.revoke(tenantA, identityA, context()),
          ),
        );
        assert.equal(results.filter((r) => r.changed).length, 1);
        assert.equal(new Set(results.map((r) => r.auditEventId)).size, 1);
        for (const result of results) {
          assert.equal(result.membership.status, 'REVOKED');
          assert.ok(result.membership.revokedAt);
          assert.equal(result.membership.revokedBy, 'test:trusted-operator');
          assert.equal(
            result.membership.createdAt.getTime(),
            before.createdAt.getTime(),
          );
        }
        assert.equal(await reads.isActive(tenantA, identityA), false);
        assert.equal((await reads.listForIdentity(identityA)).length, 2);
        assert.equal((await reads.listActiveForIdentity(identityA)).length, 1);
        await assert.rejects(
          writes.register(tenantA, identityA, context()),
          (e) => state(e, 'REVOKED_TERMINAL'),
        );
        await assert.rejects(
          raw("UPDATE memberships.membership SET status='ACTIVE' WHERE id=$1", [
            membershipA,
          ]),
          (e) => state(e, '23514'),
        );
        await assert.rejects(
          writes.revoke(tenantB, identityB, context()),
          (e) => state(e, 'NOT_FOUND'),
        );
      },
    );
    await t.test(
      'Memberships: API cannot write even via internal service, forge audit context or SET ROLE operator',
      async () => {
        for (const action of [
          () => reads.register(tenantB, identityB, context()),
          () => reads.revoke(tenantB, identityA, context()),
          () => reads.bootstrapFirst(tenantC, identityA, context()),
        ])
          await assert.rejects(action(), (e) => state(e, 'WRITE_NOT_ALLOWED'));
        await app.query(
          "SELECT set_config('innoview.membership_source','BOOTSTRAP',false)",
        );
        for (const sql of [
          `INSERT INTO memberships.membership(tenant_id,user_identity_id) VALUES('${tenantC}','${identityA}')`,
          "UPDATE memberships.membership SET status='REVOKED'",
          'DELETE FROM memberships.membership',
          'TRUNCATE memberships.membership',
          'SELECT * FROM memberships.audit_event',
          `SET ROLE ${pg.escapeIdentifier(env.DB_MEMBERSHIP_USER!)}`,
          'CREATE TABLE memberships.forbidden(id int)',
        ])
          await assert.rejects(app.query(sql), (e) => state(e, '42501'));
      },
    );
    await t.test(
      'Memberships: operator has no elevated flags, private schema access, ownership, DDL, DELETE or mutable references',
      async () => {
        const [flags] = await operator.query<{ unsafe: boolean }[]>(
          `SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS unsafe FROM pg_roles r WHERE rolname=current_user`,
        );
        assert.equal(flags.unsafe, false);
        for (const sql of [
          'SELECT * FROM identity.user_identity',
          'SELECT * FROM organizations.tenant',
          'SELECT * FROM platform_meta.migrations',
          'SELECT * FROM portal_sessions.session',
          'CREATE TABLE memberships.forbidden(id int)',
          'CREATE TEMP TABLE forbidden(id int)',
          'DELETE FROM memberships.membership',
          'TRUNCATE memberships.membership',
          'DELETE FROM memberships.audit_event',
          'UPDATE memberships.membership SET tenant_id=tenant_id',
          'UPDATE memberships.membership SET revoked_by=NULL',
          'UPDATE memberships.audit_event SET actor=actor',
          `SET ROLE ${pg.escapeIdentifier(env.DB_MIGRATOR_USER!)}`,
        ])
          await assert.rejects(operator.query(sql), (e) => state(e, '42501'));
        await assert.rejects(
          operator.query(
            'INSERT INTO memberships.membership(tenant_id,user_identity_id) VALUES($1,$2)',
            [tenantC, identityA],
          ),
          (e) => state(e, '42501'),
        );
      },
    );
    await t.test(
      'Memberships: audit cannot be forged or deleted; transition and audit roll back atomically',
      async () => {
        await assert.rejects(
          raw(
            `INSERT INTO memberships.audit_event(tenant_id,membership_id,event_type,source,actor,reason,request_id,db_actor) VALUES($1,$2,'REVOKED','TRUSTED','fake','fake',$3,'fake')`,
            [tenantA, membershipA, randomUUID()],
          ),
          (e) => state(e, '42501'),
        );
        const rows = await operator.query<
          { source: string; actor: string; db_actor: string }[]
        >(
          'SELECT source,actor,db_actor FROM memberships.audit_event WHERE membership_id=$1',
          [membershipA],
        );
        assert.equal(rows.length, 2);
        assert.ok(
          rows.every(
            (r) =>
              r.actor === 'test:trusted-operator' &&
              r.db_actor === env.DB_MEMBERSHIP_USER,
          ),
        );
        await assert.rejects(
          migrator.query('DELETE FROM memberships.membership WHERE id=$1', [
            membershipA,
          ]),
          (e) => state(e, '42501'),
        );
        await assert.rejects(
          migrator.query(
            'DELETE FROM memberships.audit_event WHERE membership_id=$1',
            [membershipA],
          ),
          (e) => state(e, '42501'),
        );
        const op = context();
        await writes.revoke(tenantB, identityA, op);
        await assert.rejects(writes.register(tenantB, identityB, op), (e) =>
          state(e, 'REQUEST_CONFLICT'),
        );
        assert.equal(await reads.isActive(tenantB, identityB), false);
      },
    );
    await t.test(
      'Memberships: transaction-local audit context does not leak to pooled connections',
      async () => {
        const values = await Promise.all(
          Array.from({ length: 8 }, () =>
            operator.query<{ actor: string | null }[]>(
              "SELECT current_setting('innoview.membership_actor',true) AS actor",
            ),
          ),
        );
        assert.ok(values.every((rows) => !rows[0].actor));
      },
    );
    await t.test(
      'Memberships: controlled real CLI bootstrap, repeatable without administrative credentials or implicit privileges',
      async () => {
        const cliEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
        for (const name of Object.keys(cliEnv))
          if (
            /^DB_(BOOTSTRAP|MIGRATOR|APP|PORTAL|CONTROL)_/.test(name) ||
            name === 'PLATFORM_POSTGRES_PASSWORD'
          )
            delete cliEnv[name];
        const requestId = randomUUID();
        const args = [
          fileURLToPath(new URL('./bootstrap.cli.js', import.meta.url)),
          '--tenant-id',
          tenantC,
          '--user-identity-id',
          identityA,
          '--request-id',
          requestId,
          '--reason',
          'First technical membership in disposable fixture',
        ];
        const run = () =>
          spawnSync(process.execPath, args, {
            env: cliEnv,
            encoding: 'utf8',
            windowsHide: true,
          });
        const first = run();
        assert.equal(first.status, 0, first.stderr);
        const second = run();
        assert.equal(second.status, 0, second.stderr);
        const initial = JSON.parse(first.stdout) as {
          changed: boolean;
          auditEventId: string;
          membershipId: string;
        };
        const repeated = JSON.parse(second.stdout) as typeof initial;
        assert.equal(initial.changed, true);
        assert.equal(repeated.changed, false);
        assert.equal(initial.auditEventId, repeated.auditEventId);
        const [event] = await operator.query<
          { actor: string; source: string }[]
        >('SELECT actor,source FROM memberships.audit_event WHERE id=$1', [
          initial.auditEventId,
        ]);
        assert.match(event.actor, /^host:.+\/user:.+$/);
        assert.equal(event.source, 'BOOTSTRAP');
        const member = (await reads.listActiveForIdentity(identityA)).find(
          (m) => m.tenantId === tenantC,
        )!;
        assert.deepEqual(
          Object.keys(
            JSON.parse(JSON.stringify(member)) as Record<string, unknown>,
          ).sort(),
          [
            'id',
            'tenantId',
            'userIdentityId',
            'status',
            'createdAt',
            'updatedAt',
            'revokedAt',
            'revokedBy',
            'revokedReason',
          ].sort(),
        );
        await assert.rejects(
          writes.bootstrapFirst(tenantC, identityB, context()),
          (e) => state(e, 'BOOTSTRAP_ALREADY_COMPLETED'),
        );
        await assert.rejects(
          writes.bootstrapFirst(tenantA, identityB, context()),
          (e) => state(e, 'BOOTSTRAP_ALREADY_COMPLETED'),
        );
        await assert.rejects(
          raw(
            'INSERT INTO memberships.membership(tenant_id,user_identity_id) VALUES($1,$2)',
            [tenantC, identityB],
            'BOOTSTRAP',
          ),
          (e) => state(e, '23514'),
        );
        await writes.revoke(tenantC, identityA, context());
        const after = run();
        assert.equal(after.status, 0, after.stderr);
        assert.equal(
          (JSON.parse(after.stdout) as { status: string }).status,
          'REVOKED',
        );
        assert.equal(await reads.isActive(tenantC, identityA), false);
        for (const password of [
          env.DB_MEMBERSHIP_PASSWORD!,
          env.DB_APP_PASSWORD!,
          env.DB_MIGRATOR_PASSWORD!,
        ])
          assert.equal(
            (
              first.stdout +
              first.stderr +
              after.stdout +
              after.stderr
            ).includes(password),
            false,
          );
      },
    );
    await t.test(
      'Memberships: concurrent first-bootstrap targets yield exactly one first member',
      async () => {
        const tenant = (
          await organizations.createTenant(
            'Bootstrap race fixture',
            'Race group',
          )
        ).tenant.id;
        const outcomes = await Promise.allSettled([
          writes.bootstrapFirst(tenant, identityA, context()),
          writes.bootstrapFirst(tenant, identityB, context()),
        ]);
        assert.equal(
          outcomes.filter((r) => r.status === 'fulfilled').length,
          1,
        );
        const [row] = await operator.query<{ count: number }[]>(
          'SELECT count(*)::int AS count FROM memberships.membership WHERE tenant_id=$1',
          [tenant],
        );
        assert.equal(row.count, 1);
      },
    );
    await t.test(
      'Memberships: cross-domain FK RESTRICT and future tenant-composite references are enforced by PostgreSQL',
      async () => {
        for (const sql of [
          'DELETE FROM organizations.tenant WHERE id=$1',
          'DELETE FROM identity.user_identity WHERE id=$1',
        ]) {
          await assert.rejects(
            migrator.query(sql, [
              sql.includes('organizations') ? tenantB : identityA,
            ]),
            (e) => state(e, '23001', '23503', '23514'),
          );
        }
        await migrator.query(
          'CREATE TABLE memberships.reference_probe(tenant_id uuid,membership_id uuid, FOREIGN KEY(tenant_id,membership_id) REFERENCES memberships.membership(tenant_id,id) ON DELETE RESTRICT)',
        );
        try {
          await migrator.query(
            'INSERT INTO memberships.reference_probe VALUES($1,$2)',
            [tenantA, membershipA],
          );
          await assert.rejects(
            migrator.query(
              'INSERT INTO memberships.reference_probe VALUES($1,$2)',
              [tenantB, membershipA],
            ),
            (e) => state(e, '23503'),
          );
          await assert.rejects(
            migrator.query('DROP TABLE memberships.membership'),
            (e) => state(e, '2BP01'),
          );
        } finally {
          await migrator.query('DROP TABLE memberships.reference_probe');
        }
      },
    );
    await t.test(
      'Memberships: credential purposes are not interchangeable, BFF cannot read and API needs no operator secret',
      async () => {
        await assert.rejects(
          initializeApplicationDataSource({
            ...env,
            DB_APP_USER: env.DB_MEMBERSHIP_USER,
            DB_APP_PASSWORD: env.DB_MEMBERSHIP_PASSWORD,
          }),
          /role validation failed/,
        );
        await assert.rejects(
          initializeMembershipOperatorDataSource({
            ...env,
            DB_MEMBERSHIP_USER: env.DB_APP_USER,
            DB_MEMBERSHIP_PASSWORD: env.DB_APP_PASSWORD,
          }),
          /role validation failed/,
        );
        const safe = await initializeApplicationDataSource({
          ...env,
          DB_MEMBERSHIP_USER: undefined,
          DB_MEMBERSHIP_PASSWORD: undefined,
          DB_MIGRATOR_PASSWORD: undefined,
          PLATFORM_POSTGRES_PASSWORD: undefined,
        });
        await safe.destroy();
        for (const kind of ['PORTAL', 'CONTROL']) {
          const client = new pg.Client({
            host: env.DB_HOST,
            port: Number(env.DB_PORT),
            database: env.DB_NAME,
            user: env[`DB_${kind}_USER`],
            password: env[`DB_${kind}_PASSWORD`],
          });
          await client.connect();
          try {
            await assert.rejects(
              client.query('SELECT * FROM memberships.membership'),
              (e) => state(e, '42501'),
            );
          } finally {
            await client.end();
          }
        }
        await assert.rejects(
          writes.register(tenantB, identityB, { ...context(), reason: ' ' }),
          (e) => state(e, 'INVALID_CONTEXT'),
        );
        const event = (
          await operator.query<{ request_id: string }[]>(
            'SELECT request_id FROM memberships.audit_event LIMIT 1',
          )
        )[0];
        await assert.rejects(
          operator.transaction(async (m: EntityManager) => {
            await m.query(
              "SELECT set_config('innoview.membership_actor','test:rollback',true),set_config('innoview.membership_reason','Atomic rollback fixture',true),set_config('innoview.membership_source','TRUSTED',true),set_config('innoview.membership_request',$1,true)",
              [event.request_id],
            );
            await m.query(
              'INSERT INTO memberships.membership(tenant_id,user_identity_id) VALUES($1,$2)',
              [tenantB, identityB],
            );
          }),
          (e) => state(e, '23505'),
        );
        assert.equal(await reads.isActive(tenantB, identityB), false);
      },
    );
    await t.test(
      'Memberships: repeated provisioning preserves history and exact ACLs; future tables stay private',
      async () => {
        await migrator.query(
          'GRANT UPDATE(tenant_id) ON memberships.membership TO ' +
            pg.escapeIdentifier(env.DB_APP_USER!),
        );
        const [before] = await operator.query<{ count: number }[]>(
          'SELECT count(*)::int AS count FROM memberships.audit_event',
        );
        await provisionDatabase(env);
        await provisionDatabase(env);
        const [after] = await operator.query<{ count: number }[]>(
          'SELECT count(*)::int AS count FROM memberships.audit_event',
        );
        assert.deepEqual(after, before);
        await assert.rejects(
          app.query('UPDATE memberships.membership SET tenant_id=tenant_id'),
          (e) => state(e, '42501'),
        );
        await migrator.query('CREATE TABLE memberships.future_probe(id int)');
        try {
          for (const source of [app, operator])
            await assert.rejects(
              source.query('SELECT * FROM memberships.future_probe'),
              (e) => state(e, '42501'),
            );
        } finally {
          await migrator.query('DROP TABLE memberships.future_probe');
        }
        assert.deepEqual(
          (await migrator.driver.createSchemaBuilder().log()).upQueries.map(
            (q) => q.query,
          ),
          [],
        );
      },
    );
  } finally {
    await operator.destroy();
  }
}
