import { containmentBenchmark } from './delegation-benchmark.mjs';
import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { performance } from 'node:perf_hooks';
import { readFile, writeFile } from 'node:fs/promises';
import { candidateQueries, summarizePlan } from './candidates.mjs';
import { signedFixture } from '../identity/signed-fixture.mjs';
import { IdentityVerifier } from '../../apps/api/dist/authentication/authentication.module.js';
import {
  AuthorizationEvaluator,
  AuthorizationReads,
} from '../../apps/api/dist/authorization/access.runtime.js';
import assert from 'node:assert/strict';
import { disposableAuthorization } from './disposable.mjs';
import { BENCHMARK_SEED, benchmarkTenant, seededUuid } from './dataset.mjs';
import {
  canonicalArguments,
  CURRENT_FINGERPRINT_VERSION,
} from '../../apps/api/dist/operations/fingerprint.js';
import { establishOperationContext } from '../../apps/api/dist/operations/operation-context.js';
import { MembershipsService } from '../../apps/api/dist/memberships/memberships.service.js';
import {
  IdentityReadTransactions,
  IdentityService,
} from '../../apps/api/dist/identity/identity.module.js';
import { TenantReadTransactions } from '../../apps/api/dist/context/context.module.js';
import { OrganizationsService } from '../../apps/api/dist/organizations/organizations.service.js';

const operation = (label) => ({
  requestId: seededUuid('operation:' + label),
  actor: 'benchmark:trusted-fixture',
  actorType: 'SYSTEM',
  reason: 'Synthetic disposable benchmark only',
});
async function fixtureOperation(source, module, tenant, type, label, write) {
  const op = operation(module + ':' + label);
  return source.transaction(async (manager) => {
    await establishOperationContext(manager, module, op, tenant);
    const fingerprint = createHash('sha256')
      .update(
        canonicalArguments({
          module,
          version: CURRENT_FINGERPRINT_VERSION,
          operation: type,
          args: { label },
        }),
      )
      .digest('hex');
    const sourceName = `${hostname()}:${userInfo().username}`;
    if (module === 'authorization') {
      await manager.query(
        'INSERT INTO "authorization".operation(request_id,tenant_id,operation_type,fingerprint,fingerprint_version,actor,actor_type,reason,technical_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          op.requestId,
          tenant,
          type,
          fingerprint,
          CURRENT_FINGERPRINT_VERSION,
          op.actor,
          op.actorType,
          op.reason,
          sourceName,
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
    } else
      await manager.query(
        'INSERT INTO organizations.operation(request_id,operation_type,fingerprint,fingerprint_version,actor,actor_type,reason,technical_source,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          op.requestId,
          type,
          fingerprint,
          CURRENT_FINGERPRINT_VERSION,
          op.actor,
          op.actorType,
          op.reason,
          sourceName,
          type === 'CREATE_TENANT' ? null : tenant,
        ],
      );
    const result = await write(manager);
    await manager.query(
      `UPDATE "${module}".operation SET ${module === 'organizations' ? 'tenant_id=$3,' : ''}result=$2::jsonb,completed_at=clock_timestamp() WHERE request_id=$1`,
      module === 'organizations'
        ? [op.requestId, JSON.stringify(result), tenant]
        : [op.requestId, JSON.stringify(result)],
    );
    return result;
  });
}
const width = Number(
  process.argv
    .find((arg) => arg.startsWith('--permissions-per-role='))
    ?.split('=')[1] ?? 2,
);
assert.ok([2, 40].includes(width));
const permissionIds = Array.from({ length: width }, (_, i) =>
  i < 2
    ? `a0000000-0000-4000-8000-00000000000${i + 1}`
    : seededUuid('permission-width:' + i),
);
const artifact = process.argv.includes('--delegation-only')
  ? 'delegation-benchmark-result.json'
  : width === 2
    ? 'benchmark-result.json'
    : 'benchmark-wide-result.json';
const expectations = {
  grants:
    'Tenant/member index access; inline queries may repeat nested membership/directory checks. Materialized grants should bound role/RP checks to tenant roles, not assignments. DISTINCT permissions/scopes remove fanout. No full cross-tenant assignment scan.',
  revision: 'Primary-key access to tenant_revision.',
  ancestors:
    'Fixed GROUP/COMPANY/BRANCH joins with explicit tenant predicates, no recursive tree.',
  operator:
    'UUID tenant index path on a small tenant under restrictive operator RLS.',
};
console.info(
  JSON.stringify({
    benchmark: '2.5 definitive evaluator: role-permission width comparison',
    seed: BENCHMARK_SEED,
    tenants: 500,
    roleAssignments: 50000,
    skew: { largeTenant: 25050, smallTenants: 499, eachSmall: 50 },
    predictions: expectations,
  }),
);
let stage = 'initialize';
const issuer = await signedFixture();
const prior = {
  OIDC_ISSUER: process.env.OIDC_ISSUER,
  AUTH_ENV: process.env.AUTH_ENV,
  AUTH_ALLOW_HTTP: process.env.AUTH_ALLOW_HTTP,
};
process.env.OIDC_ISSUER = issuer.issuer;
process.env.AUTH_ENV = 'development';
process.env.AUTH_ALLOW_HTTP = 'true';
const verifier = new IdentityVerifier();
for (const [key, value] of Object.entries(prior))
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
try {
  const report = await disposableAuthorization(async ({ sources }) => {
    const start = performance.now(),
      members = new MembershipsService(sources.membership);
    if (width === 40)
      await sources.migrator.transaction(async (manager) => {
        for (let i = 2; i < width; i++)
          await manager.query(
            "INSERT INTO \"authorization\".permission(id,code,owner_module,description) VALUES($1,$2,'foundation','Discardable width benchmark only')",
            [permissionIds[i], `foundation.benchmark_${i}.read`],
          );
      });
    const tenants = Array.from({ length: 500 }, (_, i) => benchmarkTenant(i));
    for (const tenant of tenants) {
      await fixtureOperation(
        sources.provisioner,
        'organizations',
        tenant.id,
        'CREATE_TENANT',
        `tenant:${tenant.index}`,
        async (manager) => {
          await manager.query(
            'INSERT INTO organizations.tenant(id,name) VALUES($1,$2)',
            [tenant.id, tenant.name],
          );
          await manager.query(
            "INSERT INTO organizations.organizational_unit(id,tenant_id,type,name) VALUES($1,$2,'GROUP',$3)",
            [tenant.groupId, tenant.id, `Group ${tenant.index}`],
          );
          await manager.query(
            'INSERT INTO organizations.business_group(tenant_id,id) VALUES($1,$2)',
            [tenant.id, tenant.groupId],
          );
          return { fixture: true, tenantId: tenant.id };
        },
      );
      await fixtureOperation(
        sources.organizations,
        'organizations',
        tenant.id,
        'CREATE_COMPANY',
        `structure:${tenant.index}`,
        async (manager) => {
          for (const [index, company] of tenant.companies.entries()) {
            await manager.query(
              "INSERT INTO organizations.organizational_unit(id,tenant_id,type,name) VALUES($1,$2,'COMPANY',$3),($4,$2,'BRANCH',$5)",
              [
                company.id,
                tenant.id,
                `Company ${index}`,
                company.branchId,
                `Branch ${index}`,
              ],
            );
            await manager.query(
              'INSERT INTO organizations.company(tenant_id,id,business_group_id) VALUES($1,$2,$3)',
              [tenant.id, company.id, tenant.groupId],
            );
            await manager.query(
              'INSERT INTO organizations.branch(tenant_id,id,company_id) VALUES($1,$2,$3)',
              [tenant.id, company.branchId, company.id],
            );
          }
          return { fixture: true, tenantId: tenant.id };
        },
      );
      const memberships = [];
      for (const identity of tenant.identities) {
        await sources.app.query(
          'INSERT INTO identity.user_identity(id,issuer,external_subject) VALUES($1,$2,$3)',
          [identity.id, issuer.issuer, identity.subject],
        );
        const registered = await members.register(
          tenant.id,
          identity.id,
          operation('member:' + identity.subject),
        );
        memberships.push(registered.membership.id);
      }
      tenant.membershipIds = memberships;
      const scopes = [
        { id: tenant.groupId, type: 'GROUP' },
        ...tenant.companies.flatMap((company) => [
          { id: company.id, type: 'COMPANY' },
          { id: company.branchId, type: 'BRANCH' },
        ]),
      ];
      await fixtureOperation(
        sources.authorization,
        'authorization',
        tenant.id,
        'CREATE_ROLE',
        `roles:${tenant.index}`,
        async (manager) => {
          for (const role of tenant.roles) {
            await manager.query(
              'INSERT INTO "authorization".role(id,tenant_id,name,description) VALUES($1,$2,$3,\'Synthetic benchmark role\')',
              [role.id, tenant.id, role.name],
            );
            for (const permission of permissionIds)
              await manager.query(
                'INSERT INTO "authorization".role_permission(id,tenant_id,role_id,permission_id) VALUES($1,$2,$3,$4)',
                [
                  seededUuid(role.id + ':' + permission),
                  tenant.id,
                  role.id,
                  permission,
                ],
              );
          }
          return { fixture: true, roles: tenant.roles.length };
        },
      );
      // Bounded transactions/SQL batches; all guards, revision/audit and FK stay active.
      for (let offset = 0; offset < tenant.assignments; offset += 250) {
        const count = Math.min(250, tenant.assignments - offset),
          rows = [];
        for (let i = offset; i < offset + count; i++) {
          const scope = scopes[i % scopes.length],
            role =
              tenant.roles[Math.floor(i / scopes.length) % tenant.roles.length],
            membership =
              memberships[
                Math.floor(i / (scopes.length * tenant.roles.length)) %
                  memberships.length
              ];
          rows.push([
            seededUuid(`assignment:${tenant.index}:${i}`),
            tenant.id,
            membership,
            role.id,
            scope.id,
            scope.type,
          ]);
        }
        await fixtureOperation(
          sources.authorization,
          'authorization',
          tenant.id,
          'ASSIGN',
          `assignments:${tenant.index}:${offset}`,
          async (manager) => {
            const parameters = rows.flat(),
              values = rows
                .map(
                  (_, i) =>
                    '(' +
                    Array.from(
                      { length: 6 },
                      (__, j) => '$' + (i * 6 + j + 1),
                    ).join(',') +
                    ')',
                )
                .join(',');
            await manager.query(
              'INSERT INTO "authorization".role_assignment(id,tenant_id,membership_id,role_id,scope_unit_id,scope_type) VALUES' +
                values,
              parameters,
            );
            return { fixture: true, assignments: rows.length };
          },
        );
      }
      if (tenant.index % 100 === 0)
        console.info(JSON.stringify({ seededTenants: tenant.index + 1 }));
    }
    stage = 'vacuum';
    // VACUUM cannot run in a transaction. Owner role, all RLS/triggers kept.
    for (const relation of [
      '"authorization".role_assignment',
      '"authorization".role_permission',
      '"authorization".role',
      '"authorization".permission',
      '"authorization".tenant_revision',
      'memberships.membership',
      'identity.user_identity',
      'organizations.tenant',
      'organizations.business_group',
      'organizations.organizational_unit',
      'organizations.company',
      'organizations.branch',
      'organizations.tenant_directory',
    ])
      await sources.migrator.query('VACUUM (ANALYZE) ' + relation);
    const scope = new TenantReadTransactions(
      new IdentityReadTransactions(
        sources.app,
        new IdentityService(sources.app),
      ),
      new MembershipsService(sources.app),
      new OrganizationsService(sources.app),
    );
    const plans = [];
    // Preserve the approved pre-VACUUM reference across repeated executions.
    const approved = JSON.parse(
      await readFile(
        new URL('./benchmark-result.json', import.meta.url),
        'utf8',
      ),
    );
    const baseline =
      approved.approvedBaseline ??
      approved.plans
        .filter((p) => p.query === 'grants')
        .map((p) => ({
          tenantClass: p.tenantClass,
          executionMs: p.executionMs,
          rows: p.actualRows ?? p.nodes[0].rows,
          sharedHits: p.sharedHits ?? p.nodes[0].sharedHits,
          preparation: 'ANALYZE only; no VACUUM',
        }));
    const comparisons = [];
    for (const tenant of [tenants[0], tenants[1]]) {
      const principal = await verifier.verify(
        await issuer.token(tenant.identities[0].subject),
      );
      stage = 'api-scope:' + tenant.index;
      await scope.read(principal, tenant.id, async (manager) => {
        const queries = {
          grants: {
            sql: `SELECT a.scope_type,a.scope_unit_id,p.code FROM "authorization".role_assignment a
            JOIN "authorization".role r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.status='ACTIVE'
            JOIN "authorization".role_permission rp ON rp.tenant_id=r.tenant_id AND rp.role_id=r.id AND rp.status='ACTIVE'
            JOIN "authorization".permission p ON p.id=rp.permission_id AND p.status='ACTIVE'
            WHERE a.tenant_id=$1 AND a.membership_id=$2 AND a.status='ACTIVE' AND a.scope_type='COMPANY'`,
            params: [tenant.id, seededUuid('unused')],
          },
          revision: {
            sql: 'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1',
            params: [tenant.id],
          },
          ancestors: {
            sql: `SELECT u.id,u.type FROM organizations.organizational_unit u
            JOIN organizations.business_group g ON g.tenant_id=u.tenant_id
            JOIN organizations.organizational_unit gu ON gu.tenant_id=g.tenant_id AND gu.id=g.id AND gu.status='ACTIVE'
            LEFT JOIN organizations.branch b ON b.tenant_id=u.tenant_id AND b.id=u.id
            LEFT JOIN organizations.company c ON c.tenant_id=u.tenant_id AND c.id=CASE WHEN u.type='COMPANY' THEN u.id ELSE b.company_id END
            LEFT JOIN organizations.organizational_unit cu ON cu.tenant_id=c.tenant_id AND cu.id=c.id
            WHERE u.tenant_id=$1 AND u.status='ACTIVE' AND (u.type='GROUP' OR (cu.status='ACTIVE' AND c.business_group_id=g.id))`,
            params: [tenant.id],
          },
        };
        // Obtain the current user's membership via its owner contract/RLS.
        const [membership] = await manager.query(
          'SELECT id FROM memberships.membership WHERE tenant_id=$1 AND user_identity_id=$2',
          [tenant.id, tenant.identities[0].id],
        );
        queries.grants.params[1] = membership.id;
        for (const [name, query] of Object.entries(queries)) {
          stage = `api-plan:${tenant.index}:${name}`;
          const [
            {
              'QUERY PLAN': [plan],
            },
          ] = await manager.query(
            'EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ' + query.sql,
            query.params,
          );
          const details = summarizePlan(plan);
          const summary = details.nodes;
          if (
            summary.some(
              (node) =>
                node.type === 'Seq Scan' && node.relation === 'role_assignment',
            )
          ) {
            console.info(JSON.stringify({ unexpectedPlan: summary }));
            throw new Error('Unexpected full assignment scan');
          }
          plans.push({
            tenantClass: tenant.index === 0 ? 'large' : 'small',
            query: name,
            ...details,
          });
        }
      });
    }
    for (const tenant of [tenants[0], tenants[1]]) {
      const principal = await verifier.verify(
        await issuer.token(tenant.identities[0].subject),
      );
      // Exactly one current scope/membership check per transaction via the
      // existing owner contracts. Policies still perform every nested check.
      const queries = await scope.read(
        principal,
        tenant.id,
        async (manager) => {
          const [m] = await manager.query(
            "SELECT id FROM memberships.membership WHERE tenant_id=$1 AND user_identity_id=$2 AND status='ACTIVE'",
            [tenant.id, tenant.identities[0].id],
          );
          return candidateQueries(tenant.id, m.id, tenant.companies[0].id);
        },
      );
      for (const query of queries) {
        stage = `candidate:${tenant.index}:${query.strategy}:${query.name}`;
        await scope.read(principal, tenant.id, async (manager) => {
          const [
            {
              'QUERY PLAN': [plan],
            },
          ] = await manager.query(
            'EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ' + query.sql,
            query.params,
          );
          const details = summarizePlan(plan);
          const values = await manager.query(query.sql, query.params);
          const expected =
            query.name === 'permissions'
              ? width
              : query.name === 'scopes'
                ? 1 + 2 * tenant.companies.length
                : 1;
          if (
            values.length !== expected ||
            (query.name === 'exact' && values[0].allowed !== true)
          )
            throw new Error('Candidate semantic mismatch');
          if (
            details.nodes.some(
              (n) => n.type === 'Seq Scan' && n.relation === 'role_assignment',
            )
          )
            throw new Error('Unbounded assignment scan');
          plans.push({
            tenantClass: tenant.index === 0 ? 'large' : 'small',
            query: query.name,
            strategy: query.strategy,
            sql: query.sql,
            ...details,
          });
        });
      }
    }
    stage = 'operator-plan';
    await sources.authorization.transaction(
      'REPEATABLE READ',
      async (manager) => {
        await manager.query('SET TRANSACTION READ ONLY');
        await establishOperationContext(
          manager,
          'authorization',
          operation('operator-plan'),
          tenants[1].id,
        );
        const [
          {
            'QUERY PLAN': [plan],
          },
        ] = await manager.query(
          'EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT id FROM "authorization".role_assignment WHERE tenant_id=$1',
          [tenants[1].id],
        );
        const details = summarizePlan(plan);
        const summary = details.nodes;
        if (
          !summary.some((n) =>
            ['Index Scan', 'Index Only Scan', 'Bitmap Index Scan'].includes(
              n.type,
            ),
          )
        )
          throw new Error('Expected UUID tenant index path');
        plans.push({
          tenantClass: 'small',
          query: 'operator',
          ...details,
        });
      },
    );
    if (process.argv.includes('--delegation-only'))
      return containmentBenchmark(sources, tenants[0], width);
    stage = 'runtime-evaluator';
    const appMembers = new MembershipsService(sources.app),
      appOrgs = new OrganizationsService(sources.app);
    const reads = new AuthorizationReads(sources.app, scope, appMembers),
      evaluator = new AuthorizationEvaluator(sources.app, appMembers, appOrgs);
    const measurements = [];
    const percentile = (values, p) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    for (const tenant of [tenants[0], tenants[1]]) {
      const principal = await verifier.verify(
        await issuer.token(tenant.identities[0].subject),
      );
      const scopeUnit = { type: 'COMPANY', unitId: tenant.companies[0].id };
      for (const method of ['can', 'permissionsFor', 'scopesFor']) {
        stage = `runtime:${tenant.index}:${method}`;
        const invoke = async () => {
          const totalStart = performance.now();
          let queryDuration;
          const value = await reads.read(principal, tenant.id, async (ctx) => {
            const q = performance.now();
            const result =
              method === 'can'
                ? await evaluator.can(ctx, 'foundation.probe.read', scopeUnit)
                : method === 'permissionsFor'
                  ? await evaluator.permissionsFor(ctx)
                  : await evaluator.scopesFor(ctx, 'foundation.probe.read');
            queryDuration = performance.now() - q;
            return result;
          });
          return {
            value,
            queryMs: queryDuration,
            totalMs: performance.now() - totalStart,
          };
        };
        const initial = await invoke();
        for (let i = 0; i < 3; i++) await invoke();
        const samples = [];
        for (let i = 0; i < 30; i++) samples.push(await invoke());
        const params = [
          tenant.id,
          tenant.membershipIds[0],
          tenant.identities[0].id,
          ...(method === 'permissionsFor' ? [] : ['foundation.probe.read']),
          ...(method === 'can' ? ['COMPANY', scopeUnit.unitId] : []),
        ];
        await reads.read(principal, tenant.id, async (ctx) => {
          const sql =
            evaluator.queries[
              method === 'permissionsFor'
                ? 'permissions'
                : method === 'scopesFor'
                  ? 'scopes'
                  : 'can'
            ];
          const [
            {
              'QUERY PLAN': [plan],
            },
          ] = await ctx.manager.query(
            'EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ' + sql,
            params,
          );
          const details = summarizePlan(plan);
          if (method === 'can' && tenant.index === 0)
            assert.ok(details.indexes.includes('assignment_member_scope'));
          plans.push({
            tenantClass: tenant.index === 0 ? 'large' : 'small',
            query: 'runtime:' + method,
            sql,
            ...details,
          });
          const oracle = candidateQueries(
            tenant.id,
            tenant.membershipIds[0],
            scopeUnit.unitId,
          ).find(
            (q) =>
              q.strategy === 'materialized' &&
              q.name ===
                (method === 'can'
                  ? 'exact'
                  : method === 'permissionsFor'
                    ? 'permissions'
                    : 'scopes'),
          );
          const expected = await ctx.manager.query(oracle.sql, oracle.params);
          const actual = initial.value;
          if (method === 'can')
            assert.equal(actual.allowed, expected[0].allowed);
          else if (method === 'permissionsFor')
            assert.deepEqual(
              actual,
              expected
                .map((p) => ({ id: p.permission_id, code: p.code }))
                .sort((a, b) => a.code.localeCompare(b.code)),
            );
          else
            assert.deepEqual(
              actual,
              expected
                .map((s) => ({ type: s.scope_type, unitId: s.scope_unit_id }))
                .sort(
                  (a, b) =>
                    a.type.localeCompare(b.type) ||
                    a.unitId.localeCompare(b.unitId),
                ),
            );
        });
        measurements.push({
          tenantClass: tenant.index === 0 ? 'large' : 'small',
          method,
          repetitions: 30,
          warmup: 3,
          initialObservation: {
            queryMs: initial.queryMs,
            totalMs: initial.totalMs,
            conditions:
              'First invocation after VACUUM/seeding and reference plans; no PostgreSQL buffer or OS cache flush. Not true cold.',
          },
          queryMs: {
            p50: percentile(
              samples.map((s) => s.queryMs),
              0.5,
            ),
            p95: percentile(
              samples.map((s) => s.queryMs),
              0.95,
            ),
          },
          transactionMs: {
            p50: percentile(
              samples.map((s) => s.totalMs),
              0.5,
            ),
            p95: percentile(
              samples.map((s) => s.totalMs),
              0.95,
            ),
          },
        });
      }
    }
    const target = tenants[0],
      principal = await verifier.verify(
        await issuer.token(target.identities[0].subject),
      );
    const revisions = async () =>
      sources.authorization.transaction(async (m) => {
        await establishOperationContext(
          m,
          'authorization',
          operation('versions'),
          target.id,
        );
        return {
          catalog: await m.query(
            'SELECT revision FROM "authorization".catalog_version',
          ),
          tenant: await m.query(
            'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1',
            [target.id],
          ),
        };
      });
    const versionsBefore = await revisions();
    await members.revoke(
      target.id,
      target.identities[0].id,
      operation('runtime-revoke'),
    );
    const deniedTimes = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      await assert.rejects(
        reads.read(principal, target.id, (ctx) =>
          evaluator.can(ctx, 'foundation.probe.read', {
            type: 'COMPANY',
            unitId: target.companies[0].id,
          }),
        ),
      );
      deniedTimes.push(performance.now() - start);
    }
    assert.deepEqual(await revisions(), versionsBefore);
    const revocation = {
      decision: 'UNAVAILABLE_CONTEXT on next transaction',
      rbacVersionsUnchanged: true,
      repetitions: 30,
      p50: percentile(deniedTimes, 0.5),
      p95: percentile(deniedTimes, 0.95),
    };
    const [version] = await sources.migrator.query('SELECT version()');
    stage = 'exact-counts';
    const counts = [];
    for (const [schema, tables] of Object.entries({
      authorization: [
        'permission',
        'catalog_version',
        'role',
        'role_permission',
        'role_assignment',
        'tenant_revision',
        'operation',
        'audit_event',
      ],
      memberships: ['membership', 'audit_event'],
      organizations: [
        'tenant',
        'business_group',
        'company',
        'branch',
        'organizational_unit',
        'tenant_directory',
        'operation',
        'audit_event',
      ],
    })) {
      for (const table of tables) {
        const sql = `SELECT count(*)::bigint AS rows FROM "${schema}"."${table}"`;
        let total = 0n;
        if (
          schema === 'authorization' &&
          !['permission', 'catalog_version'].includes(table)
        ) {
          for (const tenant of tenants)
            await sources.authorization.transaction(async (manager) => {
              await manager.query('SET TRANSACTION READ ONLY');
              await establishOperationContext(
                manager,
                'authorization',
                operation('count:' + tenant.index),
                tenant.id,
              );
              const [count] = await manager.query(sql);
              total += BigInt(count.rows);
            });
        } else if (
          schema === 'organizations' &&
          ['company', 'branch'].includes(table)
        ) {
          for (const tenant of tenants)
            await sources.organizations.transaction(async (manager) => {
              await manager.query(
                "SELECT set_config('innoview.tenant_id',$1,true)",
                [tenant.id],
              );
              const [count] = await manager.query(sql);
              total += BigInt(count.rows);
            });
        } else {
          const source =
            schema === 'organizations'
              ? sources.maintenance
              : schema === 'memberships'
                ? sources.membership
                : sources.app;
          const [count] = await source.query(sql);
          total = BigInt(count.rows);
        }
        counts.push({ schema, table, rows: total.toString() });
      }
    }
    if (
      counts.find(
        (row) =>
          row.schema === 'authorization' && row.table === 'role_assignment',
      ).rows !== '50000' ||
      counts.find(
        (row) => row.schema === 'organizations' && row.table === 'tenant',
      ).rows !== '500'
    )
      throw new Error('Unexpected fixture volume');
    for (const plan of baseline)
      comparisons.push({
        tenantClass: plan.tenantClass,
        previousPreparation: plan.preparation,
        previousMs: plan.executionMs,
        previousRows: plan.rows,
        previousSharedHits: plan.sharedHits,
        current: plans
          .filter(
            (p) => p.tenantClass === plan.tenantClass && p.query === 'grants',
          )
          .map(({ executionMs, actualRows, sharedHits, sharedReads }) => ({
            executionMs,
            actualRows,
            sharedHits,
            sharedReads,
          })),
        comparableLatency: false,
      });
    const indexFootprint = await sources.migrator.query(
      "SELECT c.relname AS index,pg_relation_size(c.oid)::bigint AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='authorization' AND c.relkind='i' AND c.relname IN ('assignment_member_scope','uq_active_role_assignment','assignment_tenant') ORDER BY c.relname",
    );
    return {
      permissionsPerRole: width,
      seed: BENCHMARK_SEED,
      node: process.version,
      postgres: version.version,
      tenants: 500,
      roleAssignments: 50000,
      seedDurationMs: performance.now() - start,
      counts,
      evaluatorMeasurements: measurements,
      revocation,
      preparation:
        'VACUUM (ANALYZE), outside transactions; schema14 indexable RLS/isolated operators, runtime evaluator plus frozen oracle; no OS cache flush',
      assignmentIndex:
        'Retain assignment_member_scope: measured exact-scope and small-membership index paths; no DDL or extra speculative index',
      approvedBaseline: baseline,
      indexFootprint,
      comparisons,
      predictions: expectations,
      plans,
    };
  });
  await writeFile(
    new URL('./' + artifact, import.meta.url),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.info(
    JSON.stringify({
      completed: true,
      tenants: report.tenants,
      assignments: report.roleAssignments,
      plans: report.plans.map((p) => ({
        tenantClass: p.tenantClass,
        query: p.query,
        executionMs: p.executionMs,
      })),
      artifact: 'infra/authorization/' + artifact,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      stage,
      code: typeof error.code === 'string' ? error.code : 'BENCHMARK_ASSERTION',
    }),
  );
  console.error(
    'Disposable benchmark failed; inspect fixture and role configuration. Sensitive details omitted.',
  );
  process.exitCode = 1;
} finally {
  await issuer.close();
}
