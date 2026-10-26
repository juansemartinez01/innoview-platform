import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import type { DataSource } from 'typeorm';
import pg from 'pg';
import { organizationOperation } from '../operations/fixtures.spec.js';
import {
  OrganizationsService,
  OrganizationOperationConflictError,
  OrganizationOperationError,
} from '../organizations/organizations.service.js';
import {
  correlation,
  correlationId,
  databaseFailure,
  securityEvent,
} from '../security/security-events.js';
import { connectionConfig, type Environment } from './connection.config.js';
import {
  createDataSource,
  initializeOrganizationsOperatorDataSource,
} from './data-sources.js';
import {
  directoryDifferences,
  securityInvariants,
} from './security-diagnostics.js';
import { provisionDatabase } from './provision.js';

function state(error: unknown, code: string) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

export async function verifyHardening(
  t: TestContext,
  app: DataSource,
  migrator: DataSource,
  env: Environment,
) {
  const operator = await initializeOrganizationsOperatorDataSource(env);
  const service = new OrganizationsService(operator);
  try {
    const request = organizationOperation();
    const a = await service.createTenant(
      'Hardening A',
      'Hardening group A',
      request,
    );
    const b = await service.createTenant(
      'Hardening B',
      'Hardening group B',
      organizationOperation(),
    );
    await t.test(
      'Operations: canonical tenant retry and concurrent requests return exactly one original result and audit history',
      async () => {
        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            service.createTenant(' Hardening A ', 'Hardening group A', request),
          ),
        );
        assert.ok(
          results.every((value) => {
            assert.deepEqual(value, a);
            return true;
          }),
        );
        const [counts] = await operator.query<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM organizations.audit_event WHERE operation_request_id=$1',
          [request.requestId],
        );
        assert.equal(counts.n, 3);
        const [operations] = await operator.query<{ n: number }[]>(
          'SELECT count(*)::int AS n FROM organizations.operation WHERE request_id=$1',
          [request.requestId],
        );
        assert.equal(operations.n, 1);
        const concurrent = organizationOperation();
        const created = await Promise.all(
          Array.from({ length: 8 }, () =>
            service.createTenant(
              'Concurrent logical tenant',
              'Concurrent group',
              concurrent,
            ),
          ),
        );
        for (const value of created) assert.deepEqual(value, created[0]);
        await assert.rejects(
          service.createTenant('Changed', 'Hardening group A', request),
          OrganizationOperationConflictError,
        );
        await assert.rejects(
          service.createTenant('Hardening A', 'Hardening group A', {
            ...request,
            actor: 'other:operator',
          }),
          OrganizationOperationConflictError,
        );
      },
    );
    await t.test(
      'Operations: company and branch retries, UUID normalization, cross-tenant request conflicts and omitted/null arguments',
      async () => {
        const companyRequest = organizationOperation();
        const company = await service.createCompany(
          a.tenant.id,
          a.group.id,
          ' Company ',
          undefined,
          companyRequest,
        );
        assert.deepEqual(
          await service.createCompany(
            a.tenant.id.toUpperCase(),
            a.group.id.toUpperCase(),
            'Company',
            undefined,
            companyRequest,
          ),
          company,
        );
        await assert.rejects(
          service.createCompany(
            a.tenant.id,
            a.group.id,
            'Company',
            null,
            companyRequest,
          ),
          OrganizationOperationConflictError,
        );
        await assert.rejects(
          service.createCompany(
            b.tenant.id,
            b.group.id,
            'Company',
            undefined,
            companyRequest,
          ),
          OrganizationOperationConflictError,
        );
        await assert.rejects(
          service.createTenant('Other', 'Other', companyRequest),
          OrganizationOperationConflictError,
        );
        const branchRequest = organizationOperation();
        const branches = await Promise.all(
          Array.from({ length: 6 }, () =>
            service.createBranch(
              a.tenant.id,
              company.company.id,
              'Branch',
              branchRequest,
            ),
          ),
        );
        for (const branch of branches) assert.deepEqual(branch, branches[0]);
        assert.deepEqual(
          await service.createBranch(
            a.tenant.id,
            company.company.id,
            'Branch',
            branchRequest,
          ),
          branches[0],
        );
        const history = await operator.query<
          { request_id: string; n: number }[]
        >(
          'SELECT request_id,count(*)::int AS n FROM organizations.audit_event WHERE operation_request_id=ANY($1::uuid[]) GROUP BY request_id',
          [[companyRequest.requestId, branchRequest.requestId]],
        );
        assert.equal(history.length, 2);
        assert.ok(history.every((row) => row.n === 2));
      },
    );
    await t.test(
      'Operations: state replay preserves original result, no-op changes produce no duplicate events, rollback is atomic',
      async () => {
        const statusRequest = organizationOperation();
        const original = await service.setStatus(
          a.tenant.id,
          null,
          'INACTIVE',
          statusRequest,
        );
        assert.deepEqual(
          await service.setStatus(a.tenant.id, null, 'INACTIVE', statusRequest),
          original,
        );
        await service.setStatus(
          a.tenant.id,
          null,
          'INACTIVE',
          organizationOperation(),
        );
        const [events] = await operator.query<{ n: number }[]>(
          "SELECT count(*)::int AS n FROM organizations.audit_event WHERE tenant_id=$1 AND action='STATUS_CHANGED'",
          [a.tenant.id],
        );
        assert.equal(events.n, 1);
        const bad = organizationOperation();
        const before: unknown = await operator.query<unknown>(
          'SELECT count(*)::int AS n FROM organizations.operation',
        );
        await assert.rejects(
          service.createCompany(
            a.tenant.id,
            a.group.id,
            'Rejected',
            undefined,
            bad,
          ),
          OrganizationOperationError,
        );
        assert.deepEqual(
          await operator.query(
            'SELECT count(*)::int AS n FROM organizations.operation',
          ),
          before,
        );
        assert.deepEqual(
          await operator.query(
            'SELECT id FROM organizations.audit_event WHERE request_id=$1',
            [bad.requestId],
          ),
          [],
        );
        await service.setStatus(
          a.tenant.id,
          null,
          'ACTIVE',
          organizationOperation(),
        );
        assert.deepEqual(
          await service.setStatus(a.tenant.id, null, 'INACTIVE', statusRequest),
          original,
        );
        const [current] = await operator.query<{ status: string }[]>(
          'SELECT status FROM organizations.tenant WHERE id=$1',
          [a.tenant.id],
        );
        assert.equal(current.status, 'ACTIVE');
        const incomplete = organizationOperation();
        await assert.rejects(
          operator.transaction(async (manager) => {
            await manager.query(
              "SELECT set_config('innoview.organization_actor',$1,true),set_config('innoview.organization_request',$2,true),set_config('innoview.organization_reason',$3,true),set_config('innoview.organization_actor_type','SYSTEM',true)",
              [incomplete.actor, incomplete.requestId, incomplete.reason],
            );
            await manager.query(
              "INSERT INTO organizations.operation(request_id,tenant_id,operation_type,fingerprint,actor,actor_type,reason,technical_source) VALUES($1,$2,'CREATE_TENANT',$3,$4,'SYSTEM',$5,'fixture')",
              [
                incomplete.requestId,
                a.tenant.id,
                '0'.repeat(64),
                incomplete.actor,
                incomplete.reason,
              ],
            );
          }),
          (error) => state(error, '23514'),
        );
        assert.deepEqual(
          await operator.query(
            'SELECT request_id FROM organizations.operation WHERE request_id=$1',
            [incomplete.requestId],
          ),
          [],
        );
      },
    );
    await t.test(
      'Audit: explicit technical provenance, real future Identity FK, no fabricated user actors or mutation of completed history',
      async () => {
        const [event] = await operator.query<
          {
            actor: string;
            actor_type: string;
            reason: string;
            technical_source: string;
            actor_identity_id: string | null;
          }[]
        >(
          'SELECT actor,actor_type,reason,technical_source,actor_identity_id FROM organizations.audit_event WHERE request_id=$1 LIMIT 1',
          [request.requestId],
        );
        assert.equal(event.actor, request.actor);
        assert.equal(event.actor_type, 'SYSTEM');
        assert.equal(event.reason, request.reason);
        assert.ok(event.technical_source);
        assert.equal(event.actor_identity_id, null);
        const human = organizationOperation();
        human.actorType = 'INNOVIEW_OPERATOR';
        human.actor = 'operator:approved-fixture';
        await service.createTenant(
          'Explicit operator provenance',
          'Operator group',
          human,
        );
        const [provenance] = await operator.query<
          { actor_type: string; actor: string }[]
        >(
          'SELECT actor_type,actor FROM organizations.audit_event WHERE request_id=$1 LIMIT 1',
          [human.requestId],
        );
        assert.deepEqual(provenance, {
          actor_type: 'INNOVIEW_OPERATOR',
          actor: human.actor,
        });
        const references = await migrator.query<{ name: string }[]>(
          "SELECT conrelid::regclass::text AS name FROM pg_constraint WHERE confrelid='identity.user_identity'::regclass AND contype='f' AND conrelid IN ('organizations.audit_event'::regclass,'organizations.operation'::regclass)",
        );
        assert.equal(references.length, 2);
        await assert.rejects(
          service.createTenant('Fake user', 'Fake group', {
            ...organizationOperation(),
            actorType: 'USER_IDENTITY',
            userIdentityId: randomUUID(),
          }),
          OrganizationOperationError,
        );
        for (const sql of [
          'DELETE FROM organizations.operation',
          "UPDATE organizations.operation SET result='{}'",
          'SELECT * FROM organizations.operation',
        ]) {
          await assert.rejects(app.query(sql), (error) =>
            state(error, '42501'),
          );
        }
        await assert.rejects(
          operator.query(
            "UPDATE organizations.operation SET result='{}' WHERE request_id=$1",
            [request.requestId],
          ),
          (error) => state(error, '42501'),
        );
      },
    );
    await t.test(
      'Read contract: missing, global, foreign and noncontextual EntityManagers are rejected before private SQL',
      async () => {
        await assert.rejects(
          service.getStructure(a.tenant.id, undefined as never),
          /Active local transaction/,
        );
        await assert.rejects(
          service.getStructure(a.tenant.id, operator.manager),
          /Active local transaction/,
        );
        await assert.rejects(
          service.getStructure(a.tenant.id, app.manager),
          /Active local transaction/,
        );
        await assert.rejects(
          app.transaction((manager) =>
            new OrganizationsService(app).getStructure(a.tenant.id, manager),
          ),
          /Validated tenant transaction/,
        );
        assert.equal(
          (
            await operator.transaction((manager) =>
              service.getStructure(a.tenant.id, manager),
            )
          ).tenant.id,
          a.tenant.id,
        );
      },
    );
    await t.test(
      'Catalog: discovers all managed tables, enforces explicit exceptions and detects column ACL, RLS and policy dependency drift',
      async () => {
        const healthy = await securityInvariants(operator);
        assert.deepEqual(healthy.findings, []);
        assert.equal(healthy.tables.length, 16);
        await migrator.query(
          `GRANT UPDATE(name) ON organizations.tenant TO ${pg.escapeIdentifier(env.DB_APP_USER!)}`,
        );
        try {
          assert.ok(
            (await securityInvariants(operator)).findings.some((value) =>
              value.startsWith('COLUMN_ACL:app:organizations.tenant:name'),
            ),
          );
        } finally {
          await provisionDatabase(env);
        }
        await migrator.query(
          `GRANT SELECT ON organizations.company TO ${pg.escapeIdentifier(env.DB_CONTROL_USER!)}`,
        );
        try {
          assert.ok(
            (await securityInvariants(operator)).findings.some((value) =>
              value.startsWith('COLUMN_ACL:control:organizations.company'),
            ),
          );
        } finally {
          await provisionDatabase(env);
        }
        await migrator.query(
          'ALTER TABLE organizations.tenant NO FORCE ROW LEVEL SECURITY',
        );
        try {
          assert.ok(
            (await securityInvariants(operator)).findings.includes(
              'RLS_FLAGS:organizations.tenant',
            ),
          );
        } finally {
          await migrator.query(
            'ALTER TABLE organizations.tenant FORCE ROW LEVEL SECURITY',
          );
        }
        const [saved] = await migrator.query<{ qual: string }[]>(
          "SELECT qual FROM pg_policies WHERE schemaname='organizations' AND tablename='tenant_directory' AND policyname='app_boundary'",
        );
        await migrator.query(
          'ALTER POLICY app_boundary ON organizations.tenant_directory USING(true)',
        );
        try {
          assert.ok(
            (await securityInvariants(operator)).findings.includes(
              'POLICY_CONTRACT:organizations.tenant_directory:boundary',
            ),
          );
        } finally {
          await migrator.query(
            `ALTER POLICY app_boundary ON organizations.tenant_directory USING(${saved.qual})`,
          );
        }
        await migrator.query(
          'CREATE TABLE organizations.future_inventory_probe(tenant_id uuid,private_value text)',
        );
        try {
          const report = await securityInvariants(operator);
          assert.ok(
            report.tables.some(
              (table) => table.name === 'future_inventory_probe',
            ),
          );
          assert.ok(
            report.findings.includes(
              'UNCLASSIFIED_NON_RLS:organizations.future_inventory_probe',
            ),
          );
          await migrator.query(
            `GRANT SELECT(private_value) ON organizations.future_inventory_probe TO ${pg.escapeIdentifier(env.DB_APP_USER!)}`,
          );
          assert.ok(
            (await securityInvariants(operator)).findings.some((value) =>
              value.startsWith(
                'COLUMN_ACL:app:organizations.future_inventory_probe',
              ),
            ),
          );
        } finally {
          await migrator.query(
            'DROP TABLE organizations.future_inventory_probe',
          );
        }
        assert.deepEqual((await securityInvariants(operator)).findings, []);
      },
    );
    await t.test(
      'Directory: read-only diagnostic detects isolated tampering and does not repair or bypass RLS',
      async () => {
        const check = () =>
          operator.transaction('REPEATABLE READ', async (manager) => {
            await manager.query('SET TRANSACTION READ ONLY');
            return directoryDifferences(manager);
          });
        assert.deepEqual(await check(), []);
        await assert.rejects(
          app.transaction((manager) => directoryDifferences(manager)),
          /Organizations operator required/,
        );
        const [before] = await operator.query<{ tenant_name: string }[]>(
          'SELECT tenant_name FROM organizations.tenant_directory WHERE tenant_id=$1',
          [a.tenant.id],
        );
        // Fixture-only owner maintenance inside one transaction; no dev data,
        // superuser/BYPASSRLS, permanent trigger change or production runbook shortcut.
        const tamper = async (name: string) =>
          migrator.transaction(async (manager) => {
            await manager.query(
              'CREATE POLICY fixture_directory_maintenance ON organizations.tenant_directory FOR ALL TO CURRENT_USER USING(true) WITH CHECK(true)',
            );
            await manager.query(
              'ALTER TABLE organizations.tenant_directory DISABLE TRIGGER derived_write',
            );
            await manager.query(
              'UPDATE organizations.tenant_directory SET tenant_name=$1 WHERE tenant_id=$2',
              [name, a.tenant.id],
            );
            await manager.query(
              'ALTER TABLE organizations.tenant_directory ENABLE TRIGGER derived_write',
            );
            await manager.query(
              'DROP POLICY fixture_directory_maintenance ON organizations.tenant_directory',
            );
          });
        await tamper('Intentionally divergent isolated fixture');
        try {
          const report = await check();
          assert.deepEqual(report, [
            { tenant_id: a.tenant.id, issues: ['TENANT_NAME'] },
          ]);
          assert.deepEqual(await check(), report);
        } finally {
          await tamper(before.tenant_name);
        }
        assert.deepEqual(await check(), []);
      },
    );
    await t.test(
      'Timeouts: fresh real connections receive role-specific defaults; migrator and bootstrap retain administrative settings',
      async () => {
        for (const purpose of [
          'app',
          'portal',
          'control',
          'membership',
          'organizations',
          'migrator',
          'bootstrap',
        ] as const) {
          const client = new pg.Client(connectionConfig(purpose, env));
          await client.connect();
          try {
            const {
              rows: [settings],
            } = await client.query<{
              statement: string;
              idle: string;
              transaction: string;
            }>(
              "SELECT current_setting('statement_timeout') AS statement,current_setting('idle_in_transaction_session_timeout') AS idle,current_setting('transaction_timeout') AS transaction",
            );
            const expected = ['membership', 'organizations'].includes(purpose)
              ? { statement: '20s', idle: '30s', transaction: '2min' }
              : ['migrator', 'bootstrap'].includes(purpose)
                ? { statement: '0', idle: '0', transaction: '0' }
                : { statement: '5s', idle: '10s', transaction: '30s' };
            assert.deepEqual(settings, expected);
          } finally {
            await client.end();
          }
        }
      },
    );
    await t.test(
      'Timeouts: actual statement default cancels SQL, rolls back LOCAL contexts and recovers the TypeORM pool',
      async () => {
        const single = createDataSource('app', env);
        single.setOptions({ poolSize: 1 });
        await single.initialize();
        try {
          const [first] = await single.query<{ pid: number }[]>(
            'SELECT pg_backend_pid() AS pid',
          );
          await assert.rejects(
            single.transaction(async (manager) => {
              await manager.query(
                "SELECT set_config('innoview.user_identity_id',$1,true),set_config('innoview.tenant_id',$2,true)",
                [randomUUID(), a.tenant.id],
              );
              await manager.query('SELECT pg_sleep(5.2)');
            }),
            (error) => state(error, '57014'),
          );
          const [after] = await single.query<
            { pid: number; identity: string | null; tenant: string | null }[]
          >(
            "SELECT pg_backend_pid() AS pid,NULLIF(current_setting('innoview.user_identity_id',true),'') AS identity,NULLIF(current_setting('innoview.tenant_id',true),'') AS tenant",
          );
          assert.deepEqual(after, {
            pid: first.pid,
            identity: null,
            tenant: null,
          });
          assert.deepEqual(
            await single.query('SELECT id FROM organizations.company'),
            [],
          );
        } finally {
          await single.destroy();
        }
      },
    );
    await t.test(
      'Timeouts: transaction and idle termination discard dead connections; new pooled connections are clean',
      async () => {
        const pool = new pg.Pool({ ...connectionConfig('app', env), max: 1 });
        try {
          for (const kind of ['transaction', 'idle']) {
            const client = await pool.connect();
            client.on('error', () => undefined);
            const {
              rows: [old],
            } = await client.query<{ pid: number }>(
              'SELECT pg_backend_pid() AS pid',
            );
            try {
              if (kind === 'transaction')
                await client.query(
                  "SET statement_timeout='0'; SET idle_in_transaction_session_timeout='0'; SET transaction_timeout='150ms'",
                );
              await client.query('BEGIN');
              await client.query(
                "SELECT set_config('innoview.user_identity_id',$1,true),set_config('innoview.tenant_id',$2,true)",
                [randomUUID(), a.tenant.id],
              );
              if (kind === 'transaction') {
                await client.query(
                  "SET LOCAL statement_timeout='0'; SET LOCAL idle_in_transaction_session_timeout='0'; SET LOCAL transaction_timeout='150ms'",
                );
                await assert.rejects(
                  client.query('SELECT pg_sleep(0.5)'),
                  (error) => state(error, '25P04'),
                );
              } else {
                const termination = new Promise<Error>((resolve) =>
                  client.once('error', resolve),
                );
                await client.query(
                  "SET LOCAL transaction_timeout='0'; SET LOCAL idle_in_transaction_session_timeout='150ms'",
                );
                const error = await Promise.race([
                  termination,
                  pause(2000).then(() => new Error('Timeout not enforced')),
                ]);
                assert.ok(state(error, '25P03'));
              }
            } finally {
              client.release(true);
            }
            const next = await pool.connect();
            try {
              const {
                rows: [fresh],
              } = await next.query<{
                pid: number;
                identity: string | null;
                tenant: string | null;
              }>(
                "SELECT pg_backend_pid() AS pid,NULLIF(current_setting('innoview.user_identity_id',true),'') AS identity,NULLIF(current_setting('innoview.tenant_id',true),'') AS tenant",
              );
              assert.notEqual(fresh.pid, old.pid);
              assert.equal(fresh.identity, null);
              assert.equal(fresh.tenant, null);
              assert.equal(
                (await next.query('SELECT * FROM memberships.membership')).rows
                  .length,
                0,
              );
            } finally {
              next.release();
            }
          }
        } finally {
          await pool.end();
        }
      },
    );
    await t.test(
      'Events: correlation is isolated, hostile headers replaced, SQLSTATE classified without logging sensitive error objects',
      async () => {
        const emitted: string[] = [];
        const original = console.info;
        console.info = (value: unknown) => {
          emitted.push(String(value));
        };
        try {
          const first = randomUUID(),
            second = randomUUID();
          assert.equal(correlationId(first), first);
          assert.notEqual(
            correlationId('injected\nheader'),
            'injected\nheader',
          );
          await Promise.all(
            [first, second].map((id) =>
              correlation.run(id, async () => {
                await pause(2);
                securityEvent('AUTHENTICATION_REJECTED');
              }),
            ),
          );
          securityEvent(
            databaseFailure({
              code: '42501',
              password: 'DO_NOT_LOG',
              query: 'SENSITIVE_SQL',
            }),
          );
          securityEvent(
            databaseFailure({ code: 'ECONNREFUSED', token: 'DO_NOT_LOG' }),
          );
          assert.deepEqual(
            new Set(
              emitted
                .slice(0, 2)
                .map(
                  (line) =>
                    (JSON.parse(line) as { correlationId: string })
                      .correlationId,
                ),
            ),
            new Set([first, second]),
          );
          assert.ok(emitted[2].includes('DATABASE_PRIVILEGE_REJECTED'));
          assert.ok(emitted[3].includes('DATABASE_UNAVAILABLE'));
          assert.ok(
            emitted.every(
              (line) =>
                !line.includes('DO_NOT_LOG') && !line.includes('SENSITIVE_SQL'),
            ),
          );
          const before = emitted.length;
          assert.deepEqual(
            await app.query('SELECT id FROM organizations.company'),
            [],
          );
          assert.equal(emitted.length, before);
        } finally {
          console.info = original;
        }
      },
    );
  } finally {
    await operator.destroy();
  }
}
