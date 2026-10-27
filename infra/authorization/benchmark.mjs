import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
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
        'INSERT INTO organizations.operation(request_id,operation_type,fingerprint,fingerprint_version,actor,actor_type,reason,technical_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          op.requestId,
          type,
          fingerprint,
          CURRENT_FINGERPRINT_VERSION,
          op.actor,
          op.actorType,
          op.reason,
          sourceName,
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
function nodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}
const expectations = {
  grants:
    'Tenant/member/scope B-tree access to role_assignment, then role/permission joins; no full cross-tenant assignment scan.',
  revision: 'Primary-key access to tenant_revision.',
  ancestors:
    'Fixed GROUP/COMPANY/BRANCH joins with explicit tenant predicates, no recursive tree.',
  operator:
    'UUID tenant index path on a small tenant under restrictive operator RLS.',
};
console.info(
  JSON.stringify({
    benchmark:
      'authorization persistence reference queries, not the 2.4 evaluator',
    seed: BENCHMARK_SEED,
    tenants: 500,
    roleAssignments: 50000,
    skew: { largeTenant: 25050, smallTenants: 499, eachSmall: 50 },
    predictions: expectations,
  }),
);
let stage = 'initialize';
try {
  const report = await disposableAuthorization(async ({ sources }) => {
    const start = performance.now(),
      members = new MembershipsService(sources.membership);
    const tenants = Array.from({ length: 500 }, (_, i) => benchmarkTenant(i));
    for (const tenant of tenants) {
      await fixtureOperation(
        sources.organizations,
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
          [identity.id, 'https://benchmark.invalid', identity.subject],
        );
        const registered = await members.register(
          tenant.id,
          identity.id,
          operation('member:' + identity.subject),
        );
        memberships.push(registered.membership.id);
      }
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
            for (const permission of [
              'a0000000-0000-4000-8000-000000000001',
              'a0000000-0000-4000-8000-000000000002',
            ])
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
    stage = 'analyze';
    await sources.migrator.query(
      'ANALYZE "authorization".role_assignment;ANALYZE "authorization".role_permission;ANALYZE "authorization".role;ANALYZE "authorization".tenant_revision;ANALYZE memberships.membership;ANALYZE organizations.organizational_unit;ANALYZE organizations.company;ANALYZE organizations.branch;ANALYZE organizations.tenant_directory',
    );
    const scope = new TenantReadTransactions(
      new IdentityReadTransactions(
        sources.app,
        new IdentityService(sources.app),
      ),
      new MembershipsService(sources.app),
      new OrganizationsService(sources.app),
    );
    const plans = [];
    for (const tenant of [tenants[0], tenants[1]]) {
      const principal = {
        issuer: 'https://benchmark.invalid',
        subject: tenant.identities[0].subject,
        clientId: 'innoview-portal',
      };
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
          const summary = nodes(plan.Plan).map((node) => ({
            type: node['Node Type'],
            relation: node['Relation Name'],
            index: node['Index Name'],
            rows: node['Actual Rows'],
            loops: node['Actual Loops'],
            sharedHits: node['Shared Hit Blocks'],
          }));
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
            executionMs: plan['Execution Time'],
            nodes: summary,
          });
        }
      });
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
        const summary = nodes(plan.Plan).map((n) => ({
          type: n['Node Type'],
          relation: n['Relation Name'],
          index: n['Index Name'],
          condition: n['Index Cond'],
        }));
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
          executionMs: plan['Execution Time'],
          nodes: summary,
        });
      },
    );
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
        } else {
          const source =
            schema === 'organizations'
              ? sources.organizations
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
    return {
      seed: BENCHMARK_SEED,
      node: process.version,
      postgres: version.version,
      tenants: 500,
      roleAssignments: 50000,
      seedDurationMs: performance.now() - start,
      counts,
      predictions: expectations,
      plans,
    };
  });
  await writeFile(
    new URL('./benchmark-result.json', import.meta.url),
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
      artifact: 'infra/authorization/benchmark-result.json',
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
}
