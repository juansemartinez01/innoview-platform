import {
  organizationsFixture,
  organizationsDiagnosticFixture,
} from '../organizations/organizations-fixture.spec.js';
import { TrustedOperationTransientError } from '../operations/operation-context.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type {
  DataSource,
  EntityManager,
  MigrationInterface,
  QueryRunner,
} from 'typeorm';
import { organizationOperation } from '../operations/fixtures.spec.js';
import {
  canonicalArguments,
  operationFingerprint,
} from '../operations/fingerprint.js';
import { OrganizationOperationConflictError } from '../organizations/organizations.service.js';
import {
  Tenant,
  OrganizationalUnit,
  BusinessGroup,
  Company,
} from '../organizations/entities/index.js';
import type { OrganizationOperation } from '../operations/trusted-operation.js';
import {
  createDataSource,
  initializeOrganizationsOperatorDataSource,
} from './data-sources.js';
import type { Environment } from './connection.config.js';

function state(error: unknown, code: string) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
async function setContext(
  manager: EntityManager,
  operation: OrganizationOperation,
  tenantId?: string,
) {
  if (tenantId)
    await manager.query("SELECT set_config('innoview.tenant_id',$1,true)", [
      tenantId,
    ]);
  await manager.query(
    "SELECT set_config('innoview.organization_request',$1,true),set_config('innoview.organization_actor',$2,true),set_config('innoview.organization_reason',$3,true),set_config('innoview.organization_actor_type',$4,true)",
    [
      operation.requestId,
      operation.actor,
      operation.reason,
      operation.actorType,
    ],
  );
}

// Invoked only between migrations 9 and 10 in the generated disposable DB.
export async function versionOneFixture(operator: DataSource) {
  const context = organizationOperation();
  const bytes =
    '{"version":1,"type":"CREATE_TENANT","args":{"groupName":"V1 group","name":"V1 tenant"}}';
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  const result = await operator.transaction(async (manager) => {
    await setContext(manager, context);
    await manager.query(
      "INSERT INTO organizations.operation(request_id,operation_type,fingerprint,actor,actor_type,reason,technical_source) VALUES($1,'CREATE_TENANT',$2,$3,$4,$5,'fixture:v1')",
      [
        context.requestId,
        fingerprint,
        context.actor,
        context.actorType,
        context.reason,
      ],
    );
    const tenant = await manager.save(
      Tenant,
      manager.create(Tenant, { name: 'V1 tenant', status: 'ACTIVE' }),
    );
    const unit = await manager.save(
      OrganizationalUnit,
      manager.create(OrganizationalUnit, {
        tenantId: tenant.id,
        name: 'V1 group',
        type: 'GROUP',
        status: 'ACTIVE',
      }),
    );
    const group = await manager.save(
      BusinessGroup,
      manager.create(BusinessGroup, { tenantId: tenant.id, id: unit.id }),
    );
    await manager.query(
      'UPDATE organizations.operation SET tenant_id=$2,result=$3::jsonb,completed_at=clock_timestamp() WHERE request_id=$1',
      [context.requestId, tenant.id, JSON.stringify({ tenant, unit, group })],
    );
    return { tenant, unit, group };
  });
  const before = (await operator.query(
    'SELECT * FROM organizations.audit_event WHERE operation_request_id=$1 ORDER BY id',
    [context.requestId],
  )) as unknown;
  const companyContext = organizationOperation();
  // Field insertion order below is the historical v1 byte contract, including
  // the nested tax marker. Do not use the new canonicalizer to seed history.
  const companyHash = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        type: 'CREATE_COMPANY',
        args: {
          businessGroupId: result.group.id,
          name: 'V1 company',
          taxId: { kind: 'value', value: 'OLD-TAX' },
          tenantId: result.tenant.id,
        },
      }),
    )
    .digest('hex');
  const companyResult = await operator.transaction(async (manager) => {
    await setContext(manager, companyContext);
    await manager.query(
      "INSERT INTO organizations.operation(request_id,tenant_id,operation_type,fingerprint,actor,actor_type,reason,technical_source) VALUES($1,$2,'CREATE_COMPANY',$3,$4,$5,$6,'fixture:v1')",
      [
        companyContext.requestId,
        result.tenant.id,
        companyHash,
        companyContext.actor,
        companyContext.actorType,
        companyContext.reason,
      ],
    );
    const unit = await manager.save(
      OrganizationalUnit,
      manager.create(OrganizationalUnit, {
        tenantId: result.tenant.id,
        name: 'V1 company',
        type: 'COMPANY',
        status: 'ACTIVE',
      }),
    );
    const company = await manager.save(
      Company,
      manager.create(Company, {
        tenantId: result.tenant.id,
        id: unit.id,
        businessGroupId: result.group.id,
        taxId: 'OLD-TAX',
      }),
    );
    await manager.query(
      'UPDATE organizations.operation SET result=$2::jsonb,completed_at=clock_timestamp() WHERE request_id=$1',
      [companyContext.requestId, JSON.stringify({ company, unit })],
    );
    return { company, unit };
  });
  const companyAudit = await operator.query<unknown>(
    'SELECT * FROM organizations.audit_event WHERE operation_request_id=$1 ORDER BY id',
    [companyContext.requestId],
  );
  return {
    context,
    fingerprint,
    result: JSON.parse(JSON.stringify(result)) as unknown,
    before,
    company: {
      context: companyContext,
      fingerprint: companyHash,
      result: JSON.parse(JSON.stringify(companyResult)) as unknown,
      before: companyAudit,
      tenantId: result.tenant.id,
      groupId: result.group.id,
    },
  };
}
export async function verifyVersionOneUpgrade(
  operator: DataSource,
  fixture: Awaited<ReturnType<typeof versionOneFixture>>,
  env: Environment,
) {
  const service = await organizationsFixture(operator, env);
  const diagnostic = await organizationsDiagnosticFixture(operator, env);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        await service.createTenant(' V1 tenant ', 'V1 group', fixture.context),
      ),
    ),
    fixture.result,
  );
  const [stored] = await diagnostic.query<
    { fingerprint_version: number; fingerprint: string }[]
  >(
    'SELECT fingerprint_version,fingerprint FROM organizations.operation WHERE request_id=$1',
    [fixture.context.requestId],
  );
  assert.deepEqual(stored, {
    fingerprint_version: 1,
    fingerprint: fixture.fingerprint,
  });
  assert.deepEqual(
    await diagnostic.query(
      'SELECT * FROM organizations.audit_event WHERE operation_request_id=$1 ORDER BY id',
      [fixture.context.requestId],
    ),
    fixture.before,
  );
  const companyReplay = await service.createCompany(
    fixture.company.tenantId.toUpperCase(),
    fixture.company.groupId,
    ' V1 company ',
    'OLD-TAX',
    fixture.company.context,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(companyReplay)),
    fixture.company.result,
  );
  assert.deepEqual(
    (
      await diagnostic.query<
        { fingerprint_version: number; fingerprint: string }[]
      >(
        'SELECT fingerprint_version,fingerprint FROM organizations.operation WHERE request_id=$1',
        [fixture.company.context.requestId],
      )
    )[0],
    { fingerprint_version: 1, fingerprint: fixture.company.fingerprint },
  );
  assert.deepEqual(
    await diagnostic.query(
      'SELECT * FROM organizations.audit_event WHERE operation_request_id=$1 ORDER BY id',
      [fixture.company.context.requestId],
    ),
    fixture.company.before,
  );
  await assert.rejects(
    service.createTenant('Changed V1', 'V1 group', fixture.context),
    OrganizationOperationConflictError,
  );
}

interface Plan {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Plans?: Plan[];
}
function flatten(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(flatten)];
}

class LockContentionProbe1793041200000 implements MigrationInterface {
  name = 'LockContentionProbe1793041200000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query('CREATE TABLE organizations.lock_atomic_probe(id int)');
    await runner.query(
      'ALTER TABLE organizations.tenant ADD COLUMN lock_probe integer',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE organizations.tenant DROP COLUMN lock_probe',
    );
    await runner.query('DROP TABLE organizations.lock_atomic_probe');
  }
}

export async function verifyOperationHardening(
  t: TestContext,
  migrator: DataSource,
  env: Environment,
) {
  assert.match(env.DB_NAME ?? '', /^innoview_test_[a-f0-9]{32}$/);
  const operator = await initializeOrganizationsOperatorDataSource(env);
  const writes = await organizationsFixture(operator, env);
  const diagnostic = await organizationsDiagnosticFixture(operator, env);
  try {
    const record = await writes.createTenant(
      'Trigger hardening fixture',
      'Trigger group',
      organizationOperation(),
    );
    await t.test(
      'Fingerprints: recursive v2 is deterministic, ordered arrays and omission/null/value differ; unsupported structures reject',
      () => {
        assert.equal(
          canonicalArguments({
            b: [{ z: 1, a: null }, undefined],
            a: { y: true, x: 'text' },
          }),
          canonicalArguments({
            a: { x: 'text', y: true },
            b: [{ a: null, z: 1 }, undefined],
          }),
        );
        assert.notEqual(canonicalArguments([1, 2]), canonicalArguments([2, 1]));
        assert.equal(
          new Set([
            canonicalArguments({}),
            canonicalArguments({ x: undefined }),
            canonicalArguments({ x: null }),
            canonicalArguments({ x: 'undefined' }),
            canonicalArguments({ x: { $undefined: true } }),
          ]).size,
          5,
        );
        let invoked = false;
        const getter = {
          get value() {
            invoked = true;
            return 'bad';
          },
        };
        const cycle: { self?: unknown } = {};
        cycle.self = cycle;
        for (const value of [
          NaN,
          Infinity,
          1n,
          () => undefined,
          Symbol('x'),
          new Date(),
          new Map(),
          new Set(),
          cycle,
          getter,
          new Array(2),
          { [Symbol('x')]: 1 },
        ])
          assert.throws(() => canonicalArguments(value));
        assert.equal(invoked, false);
        assert.equal(
          operationFingerprint(1, 'CREATE_TENANT', {
            name: 'V1 tenant',
            groupName: 'V1 group',
          }),
          createHash('sha256')
            .update(
              '{"version":1,"type":"CREATE_TENANT","args":{"groupName":"V1 group","name":"V1 tenant"}}',
            )
            .digest('hex'),
        );
        assert.notEqual(
          operationFingerprint(2, 'CREATE_COMPANY', {
            tax: { kind: 'value', value: 'X' },
          }),
          operationFingerprint(2, 'CREATE_BRANCH', {
            tax: { value: 'X', kind: 'value' },
          }),
        );
      },
    );
    await t.test(
      'Fingerprints: new operations are v2, nested-key equivalence and incompatible replay remain explicit',
      async () => {
        const context = organizationOperation();
        const company = await writes.createCompany(
          record.tenant.id,
          record.group.id,
          'Fingerprint company',
          'TEST',
          context,
        );
        assert.deepEqual(
          await writes.createCompany(
            record.tenant.id,
            record.group.id,
            ' Fingerprint company ',
            'TEST',
            context,
          ),
          company,
        );
        const [row] = await diagnostic.query<{ fingerprint_version: number }[]>(
          'SELECT fingerprint_version FROM organizations.operation WHERE request_id=$1',
          [context.requestId],
        );
        assert.equal(row.fingerprint_version, 2);
        assert.equal(
          operationFingerprint(2, 'TEST', {
            nested: { b: 2, a: [null, undefined] },
          }),
          operationFingerprint(2, 'TEST', {
            nested: { a: [null, undefined], b: 2 },
          }),
        );
        await assert.rejects(
          writes.createCompany(
            record.tenant.id,
            record.group.id,
            'Fingerprint company',
            null,
            context,
          ),
          OrganizationOperationConflictError,
        );
      },
    );
    await t.test(
      'Triggers: malformed, missing and noncanonical GUC reject with 42501 in both functions, never 22P02',
      async () => {
        for (const isolateAudit of [false, true]) {
          if (isolateAudit)
            await migrator.query(
              'ALTER TABLE organizations.tenant DISABLE TRIGGER operator_write',
            );
          try {
            const runner = operator.createQueryRunner();
            await runner.connect();
            await runner.startTransaction();
            try {
              for (const invalid of [
                '',
                'not-uuid',
                'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
                '12345678-1234-1234-1234-12345678901z',
              ]) {
                await runner.query('SAVEPOINT invalid_context');
                await runner.query(
                  "SELECT set_config('innoview.organization_request',$1,true)",
                  [invalid],
                );
                await assert.rejects(
                  runner.query(
                    "INSERT INTO organizations.tenant(name) VALUES('Invalid GUC fixture')",
                  ),
                  (error) => state(error, '42501'),
                );
                await runner.query('ROLLBACK TO SAVEPOINT invalid_context');
              }
            } finally {
              await runner.rollbackTransaction();
              await runner.release();
            }
            // A new real operator connection has no custom setting at all.
            const fresh = createDataSource('organizations', env);
            await fresh.initialize();
            try {
              await assert.rejects(
                fresh.query(
                  "INSERT INTO organizations.tenant(name) VALUES('Absent GUC')",
                ),
                (error) => state(error, '42501'),
              );
            } finally {
              await fresh.destroy();
            }
          } finally {
            if (isolateAudit)
              await migrator.query(
                'ALTER TABLE organizations.tenant ENABLE TRIGGER operator_write',
              );
          }
        }
      },
    );

    await t.test(
      'Operation UPDATE: mismatched request cannot complete another pending row; current context can complete and then history is immutable',
      async () => {
        const context = organizationOperation();
        await operator.transaction(async (manager) => {
          await setContext(manager, context, record.tenant.id);
          await manager.query(
            "INSERT INTO organizations.operation(request_id,tenant_id,operation_type,fingerprint,actor,actor_type,reason,technical_source,fingerprint_version) VALUES($1,$2,'SET_STATUS',$3,$4,$5,$6,'fixture:update',2)",
            [
              context.requestId,
              record.tenant.id,
              '0'.repeat(64),
              context.actor,
              context.actorType,
              context.reason,
            ],
          );
          await manager.query('SAVEPOINT mismatched_context');
          await manager.query(
            "SELECT set_config('innoview.organization_request',$1,true)",
            [randomUUID()],
          );
          await assert.rejects(
            manager.query(
              "UPDATE organizations.operation SET result='{}',completed_at=clock_timestamp() WHERE request_id=$1",
              [context.requestId],
            ),
            (error) => state(error, '42501'),
          );
          await manager.query('ROLLBACK TO SAVEPOINT mismatched_context');
          const [pending] = await manager.query<
            { completed_at: Date | null; result: unknown }[]
          >(
            'SELECT completed_at,result FROM organizations.operation WHERE request_id=$1',
            [context.requestId],
          );
          assert.deepEqual(pending, { completed_at: null, result: null });
          await manager.query(
            "UPDATE organizations.operation SET result='{}',completed_at=clock_timestamp() WHERE request_id=$1",
            [context.requestId],
          );
        });
        await assert.rejects(
          operator.transaction(async (manager) => {
            await setContext(manager, context, record.tenant.id);
            await manager.query(
              "UPDATE organizations.operation SET result='{}' WHERE request_id=$1",
              [context.requestId],
            );
          }),
          (error) => state(error, '42501'),
        );
      },
    );
    await t.test(
      'Audit: no historical default for new rows; verified provenance requires technical source without rewriting legacy',
      async () => {
        const [column] = await migrator.query<{ has_default: boolean }[]>(
          "SELECT atthasdef AS has_default FROM pg_attribute WHERE attrelid='organizations.audit_event'::regclass AND attname='actor_type'",
        );
        assert.equal(column.has_default, false);
        const [operation] = await diagnostic.query<{ request_id: string }[]>(
          'SELECT request_id FROM organizations.operation WHERE tenant_id=$1 LIMIT 1',
          [record.tenant.id],
        );
        for (const omitType of [true, false]) {
          const runner = migrator.createQueryRunner();
          await runner.connect();
          await runner.startTransaction();
          try {
            // Isolated constraint probe under the owner, rolled back completely.
            await runner.query(
              'CREATE POLICY fixture_audit_constraint ON organizations.audit_event FOR INSERT TO CURRENT_USER WITH CHECK(true)',
            );
            await runner.query(
              'ALTER TABLE organizations.audit_event DISABLE TRIGGER derived_write',
            );
            const base =
              'INSERT INTO organizations.audit_event(tenant_id,record_id,record_type,action,actor,db_actor,request_id';
            const sql = omitType
              ? base +
                ") VALUES($1,$1,'tenant','INSERT','fixture',current_user,$2)"
              : base +
                ",actor_type,reason,operation_request_id) VALUES($1,$1,'tenant','INSERT','fixture',current_user,$2,'SYSTEM','Constraint probe',$2)";
            await assert.rejects(
              runner.query(sql, [record.tenant.id, operation.request_id]),
              (error) => state(error, omitType ? '23502' : '23514'),
            );
          } finally {
            await runner.rollbackTransaction();
            await runner.release();
          }
        }
      },
    );
    await t.test(
      'Plans: 20000 safe synthetic operation records expose the old scan and UUID PK index paths for both trigger predicates',
      async () => {
        const context = organizationOperation();
        for (let batch = 0; batch < 20; batch++)
          await operator.transaction(async (manager) => {
            await setContext(manager, context, record.tenant.id);
            await manager.query(
              "SELECT set_config('innoview.fixture_tenant',$1,true)",
              [record.tenant.id],
            );
            await manager.query(`DO $$ DECLARE op uuid; i integer; BEGIN
          FOR i IN 1..1000 LOOP
            op=gen_random_uuid();PERFORM set_config('innoview.organization_request',op::text,true);
            INSERT INTO organizations.operation(request_id,tenant_id,operation_type,fingerprint,actor,actor_type,reason,technical_source,fingerprint_version)
              VALUES(op,current_setting('innoview.fixture_tenant')::uuid,'SET_STATUS',repeat('0',64),current_setting('innoview.organization_actor'),current_setting('innoview.organization_actor_type'),current_setting('innoview.organization_reason'),'synthetic:plan-only',2);
            UPDATE organizations.operation SET result='{"fixture":true}',completed_at=clock_timestamp() WHERE request_id=op;
          END LOOP;
        END $$`);
          });
        await migrator.query('ANALYZE organizations.operation');
        const [{ request_id: target }] = await diagnostic.query<
          { request_id: string }[]
        >(
          'SELECT request_id FROM organizations.operation WHERE tenant_id=$1 LIMIT 1',
          [record.tenant.id],
        );
        const explain = async (predicate: string) => {
          const [
            {
              'QUERY PLAN': [document],
            },
          ] = await diagnostic.query<{ 'QUERY PLAN': { Plan: Plan }[] }[]>(
            `EXPLAIN(FORMAT JSON) SELECT o.* FROM organizations.operation o WHERE ${predicate} AND o.completed_at IS NULL AND o.actor=$2 AND o.reason=$3 AND o.actor_type=$4`,
            [target, context.actor, context.reason, context.actorType],
          );
          return flatten(document.Plan);
        };
        const before = await explain('o.request_id::text=$1::text');
        assert.ok(
          before.some(
            (node) =>
              node['Node Type'] === 'Seq Scan' &&
              node['Relation Name'] === 'operation',
          ),
        );
        for (const label of ['guard_operator_write', 'audit_change']) {
          const after = await explain('o.request_id=$1::uuid');
          assert.ok(
            after.some(
              (node) =>
                ['Index Scan', 'Index Only Scan', 'Bitmap Index Scan'].includes(
                  node['Node Type'],
                ) && node['Index Name']?.includes('pkey'),
            ),
          );
          assert.ok(
            !after.some(
              (node) =>
                node['Node Type'] === 'Seq Scan' &&
                node['Relation Name'] === 'operation',
            ),
          );
          console.info(
            JSON.stringify({
              planProbe: label,
              syntheticOperations: 20000,
              before: before.map((n) => n['Node Type']),
              after: after.map((n) => ({
                type: n['Node Type'],
                index: n['Index Name'],
                condition: n['Index Cond'],
              })),
            }),
          );
        }
        const functions = await migrator.query<
          { proname: string; prosrc: string }[]
        >(
          "SELECT proname,prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='organizations' AND proname IN ('guard_operator_write','audit_change')",
        );
        assert.equal(functions.length, 2);
        for (const fn of functions) {
          assert.match(fn.prosrc, /o\.request_id\s*=\s*operation_uuid/);
          assert.doesNotMatch(fn.prosrc, /request_id\s*::\s*text/);
          assert.ok(
            fn.prosrc.indexOf("ERRCODE='42501'") <
              fn.prosrc.indexOf('operation_uuid=operation_text::uuid'),
          );
        }
      },
    );
    await t.test(
      'Locks: real operator lock_timeout cancels without partial records or audit, then the pool retries successfully',
      async () => {
        const blocker = operator.createQueryRunner();
        await blocker.connect();
        await blocker.startTransaction();
        await blocker.query("SELECT set_config('innoview.tenant_id',$1,true)", [
          record.tenant.id,
        ]);
        const context = organizationOperation();
        try {
          await blocker.query(
            'SELECT id FROM organizations.tenant WHERE id=$1 FOR UPDATE',
            [record.tenant.id],
          );
          await assert.rejects(
            writes.createCompany(
              record.tenant.id,
              record.group.id,
              'Lock retry',
              undefined,
              context,
            ),
            TrustedOperationTransientError,
          );
          assert.deepEqual(
            await diagnostic.query(
              'SELECT request_id FROM organizations.operation WHERE request_id=$1',
              [context.requestId],
            ),
            [],
          );
          assert.deepEqual(
            await diagnostic.query(
              'SELECT id FROM organizations.audit_event WHERE request_id=$1',
              [context.requestId],
            ),
            [],
          );
        } finally {
          await blocker.rollbackTransaction();
          await blocker.release();
        }
        const created = await writes.createCompany(
          record.tenant.id,
          record.group.id,
          'Lock retry',
          undefined,
          context,
        );
        assert.deepEqual(
          await writes.createCompany(
            record.tenant.id,
            record.group.id,
            'Lock retry',
            undefined,
            context,
          ),
          created,
        );
      },
    );
    await t.test(
      'Locks: application timeout rolls back LOCAL context and recovers the same pooled connection',
      async () => {
        const single = createDataSource('app', env);
        single.setOptions({ poolSize: 1 });
        await single.initialize();
        const blocker = migrator.createQueryRunner();
        await blocker.connect();
        await blocker.startTransaction();
        await blocker.query("SELECT set_config('innoview.tenant_id',$1,true)", [
          record.tenant.id,
        ]);
        const [before] = await single.query<{ pid: number }[]>(
          'SELECT pg_backend_pid() AS pid',
        );
        try {
          await blocker.query(
            'LOCK TABLE organizations.tenant IN ACCESS EXCLUSIVE MODE',
          );
          await assert.rejects(
            single.transaction(async (manager) => {
              await manager.query(
                "SELECT set_config('innoview.user_identity_id',$1,true),set_config('innoview.tenant_id',$2,true)",
                [randomUUID(), record.tenant.id],
              );
              await manager.query('SELECT id FROM organizations.tenant');
            }),
            (error) => state(error, '55P03'),
          );
        } finally {
          await blocker.rollbackTransaction();
          await blocker.release();
        }
        try {
          const [after] = await single.query<
            { pid: number; identity: string | null; tenant: string | null }[]
          >(
            "SELECT pg_backend_pid() AS pid,NULLIF(current_setting('innoview.user_identity_id',true),'') AS identity,NULLIF(current_setting('innoview.tenant_id',true),'') AS tenant",
          );
          assert.deepEqual(after, {
            pid: before.pid,
            identity: null,
            tenant: null,
          });
          assert.deepEqual(
            await single.query('SELECT id FROM organizations.tenant'),
            [],
          );
        } finally {
          await single.destroy();
        }
      },
    );
    await t.test(
      'Locks: migrator DDL times out with 55P03; transactional schema and history remain unchanged and retry succeeds',
      async () => {
        const blocker = operator.createQueryRunner();
        await blocker.connect();
        await blocker.startTransaction();
        await blocker.query("SELECT set_config('innoview.tenant_id',$1,true)", [
          record.tenant.id,
        ]);
        const probe = createDataSource('migrator', env);
        probe.setOptions({ migrations: [LockContentionProbe1793041200000] });
        await probe.initialize();
        const before = await migrator.query<unknown>(
          'SELECT * FROM platform_meta.migrations ORDER BY id',
        );
        try {
          try {
            await blocker.query('SELECT id FROM organizations.tenant LIMIT 1');
            await assert.rejects(probe.runMigrations(), (error) =>
              state(error, '55P03'),
            );
            const [rollback] = await migrator.query<
              { table_missing: boolean; column_missing: boolean }[]
            >(
              "SELECT to_regclass('organizations.lock_atomic_probe') IS NULL AS table_missing,NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='organizations.tenant'::regclass AND attname='lock_probe' AND NOT attisdropped) AS column_missing",
            );
            assert.deepEqual(rollback, {
              table_missing: true,
              column_missing: true,
            });
            assert.deepEqual(
              await migrator.query(
                'SELECT * FROM platform_meta.migrations ORDER BY id',
              ),
              before,
            );
          } finally {
            await blocker.rollbackTransaction();
            await blocker.release();
          }
          assert.equal((await probe.runMigrations()).length, 1);
          await probe.undoLastMigration();
          assert.deepEqual(
            await migrator.query(
              'SELECT * FROM platform_meta.migrations ORDER BY id',
            ),
            before,
          );
        } finally {
          await probe.destroy();
        }
      },
    );
  } finally {
    await operator.destroy();
  }
}
