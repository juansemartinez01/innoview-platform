import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { AuthorizationService } from '../../apps/api/dist/authorization/authorization.service.js';
import { OrganizationsService } from '../../apps/api/dist/organizations/organizations.service.js';
import { MembershipsService } from '../../apps/api/dist/memberships/memberships.service.js';
import { establishOperationLocals } from '../../apps/api/dist/operations/operation-context.js';
import { summarizePlan } from './candidates.mjs';
import { BENCHMARK_SEED, seededUuid } from './dataset.mjs';

export async function containmentBenchmark(sources, tenant, width) {
  const prediction =
    'Exact tenant/member/type/unit probes should use assignment_member_scope under the large skewed fixture; set containment deduplicates overlapping role grants. No full cross-tenant assignment scan. No latency SLA.';
  console.info(JSON.stringify({ containmentPrediction: prediction }));
  const members = new MembershipsService(sources.membership),
    orgs = new OrganizationsService(sources.organizations);
  const writer = new AuthorizationService(sources.authorization, {
    membershipActive: (t, m) => members.activeMembershipReference(t, m),
    scopeAvailable: (t, u, type) => orgs.availableScopeReference(t, u, type),
  });
  const op = (label) => ({
    requestId: seededUuid('delegation-benchmark:' + label),
    actor: 'benchmark:innoview-operator',
    actorType: 'INNOVIEW_OPERATOR',
    reason: 'Discardable containment EXPLAIN',
  });
  const role = await writer.createRole(
    tenant.id,
    'Containment benchmark authority',
    'Fixture',
    op('role'),
  );
  await writer.grantPermission(
    tenant.id,
    role.id,
    'authorization.assignment.grant',
    op('permission'),
  );
  await writer.assign(
    tenant.id,
    tenant.membershipIds[0],
    role.id,
    { type: 'COMPANY', unitId: tenant.companies[0].id },
    op('bootstrap'),
    'GRANT_TENANT_ADMIN',
  );
  const [definition] = await sources.migrator.query(
    "SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='authorization' AND p.proname='delegation_allowed'",
  );
  const plan = await sources.delegation.transaction(
    'READ COMMITTED',
    async (manager) => {
      await establishOperationLocals(
        manager,
        'authorization',
        {
          requestId: seededUuid('delegation-benchmark:explain'),
          actor: tenant.identities[0].id,
          actorType: 'USER_IDENTITY',
          reason: 'Read-only benchmark context',
        },
        tenant.id,
      );
      await manager.query(
        "SELECT set_config('innoview.user_identity_id',$1,true),set_config('innoview.delegation_actor_membership',$2,true),set_config('innoview.delegation_target_membership',$3,true)",
        [
          tenant.identities[0].id,
          tenant.membershipIds[0],
          tenant.membershipIds[1],
        ],
      );
      const parameters = [
        tenant.id,
        tenant.membershipIds[0],
        tenant.identities[0].id,
        tenant.roles[0].id,
        'COMPANY',
        tenant.companies[0].id,
        tenant.membershipIds[1],
      ];
      assert.equal(
        (
          await manager.query(
            'SELECT "authorization".delegation_allowed($1,$2,$3,$4,$5,$6,$7) AS allowed',
            parameters,
          )
        )[0].allowed,
        true,
      );
      const [
        {
          'QUERY PLAN': [raw],
        },
      ] = await manager.query(
        'EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ' + definition.prosrc,
        parameters,
      );
      const summary = summarizePlan(raw);
      assert.ok(
        summary.nodes.some((node) => node.index === 'assignment_member_scope'),
        'Representative exact-scope query should use assignment_member_scope',
      );
      return { sql: definition.prosrc, ...summary };
    },
  );
  return {
    measurementSource:
      'working tree at invocation; not the future published SHA',
    baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    seed: BENCHMARK_SEED,
    tenants: 500,
    roleAssignments: 50000,
    additionalBootstrapAssignments: 1,
    permissionsPerOrdinaryRole: width,
    prediction,
    methodology:
      'PostgreSQL 18 disposable role; expanded exact function body under delegation RLS, after existing seed/VACUUM/reference plans. Shared local host, warm buffers; no OS cache flush or production SLA.',
    plans: [{ tenantClass: 'large', query: 'delegated-containment', ...plan }],
  };
}
