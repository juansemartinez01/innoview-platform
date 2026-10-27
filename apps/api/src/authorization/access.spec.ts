import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { DataSource, Logger } from 'typeorm';
import { signedFixture } from '../../../../infra/identity/signed-fixture.mjs';
import { candidateQueries } from '../../../../infra/authorization/candidates.mjs';
import { IdentityVerifier } from '../authentication/authentication.module.js';
import {
  IdentityService,
  IdentityReadTransactions,
} from '../identity/identity.module.js';
import { TenantReadTransactions } from '../context/context.module.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import {
  initializeAuthorizationOperatorDataSource,
  initializeMembershipOperatorDataSource,
  initializeOrganizationsOperatorDataSource,
  createDataSource,
} from '../persistence/data-sources.js';
import type { Environment } from '../persistence/connection.config.js';
import { organizationOperation as op } from '../operations/fixtures.spec.js';
import { AuthorizationService } from './authorization.service.js';
import {
  AuthorizationEvaluator,
  AuthorizationReads,
} from './access.runtime.js';
import type { AuthorizationContext, Scope } from './access.contract.js';

export async function verifyAccess(
  t: TestContext,
  app: DataSource,
  migrator: DataSource,
  env: Environment,
) {
  const auth = await initializeAuthorizationOperatorDataSource(env),
    member = await initializeMembershipOperatorDataSource(env),
    org = await initializeOrganizationsOperatorDataSource(env);
  const members = new MembershipsService(member),
    orgs = new OrganizationsService(org),
    identities = new IdentityService(app),
    appMembers = new MembershipsService(app),
    appOrgs = new OrganizationsService(app);
  const factory = new AuthorizationReads(
      app,
      new TenantReadTransactions(
        new IdentityReadTransactions(app, identities),
        appMembers,
        appOrgs,
      ),
      appMembers,
    ),
    evaluator = new AuthorizationEvaluator(app, appMembers, appOrgs);
  const writer = new AuthorizationService(auth, {
    membershipActive: (tenant, id) =>
      members.activeMembershipReference(tenant, id),
    scopeAvailable: (tenant, id, type) =>
      orgs.availableScopeReference(tenant, id, type),
  });
  const issuer = await signedFixture();
  const old = {
    OIDC_ISSUER: process.env.OIDC_ISSUER,
    AUTH_ENV: process.env.AUTH_ENV,
    AUTH_ALLOW_HTTP: process.env.AUTH_ALLOW_HTTP,
  };
  process.env.OIDC_ISSUER = issuer.issuer;
  process.env.AUTH_ENV = 'development';
  process.env.AUTH_ALLOW_HTTP = 'true';
  const verifier = new IdentityVerifier();
  for (const [key, value] of Object.entries(old))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  const tenant = await orgs.createTenant(
      'Effective A',
      'Effective group A',
      op(),
    ),
    foreign = await orgs.createTenant('Effective B', 'Effective group B', op());
  const company = await orgs.createCompany(
      tenant.tenant.id,
      tenant.group.id,
      'Effective company A',
      null,
      op(),
    ),
    sibling = await orgs.createCompany(
      tenant.tenant.id,
      tenant.group.id,
      'Effective company sibling',
      null,
      op(),
    );
  const branch = await orgs.createBranch(
      tenant.tenant.id,
      company.company.id,
      'Effective branch A',
      op(),
    ),
    otherBranch = await orgs.createBranch(
      tenant.tenant.id,
      sibling.company.id,
      'Effective branch sibling',
      op(),
    );
  const companyB = await orgs.createCompany(
    foreign.tenant.id,
    foreign.group.id,
    'Foreign company',
    null,
    op(),
  );
  const user = async (tenants: string[]) => {
    const principal = await verifier.verify(await issuer.token(randomUUID()));
    const identity = await identities.resolve(principal);
    const memberships = [];
    for (const tenantId of tenants)
      memberships.push(
        (await members.register(tenantId, identity.id, op())).membership.id,
      );
    return { principal, identity: identity.id, memberships };
  };
  const a = await user([tenant.tenant.id]),
    b = await user([tenant.tenant.id]),
    c = await user([foreign.tenant.id]),
    multi = await user([tenant.tenant.id, foreign.tenant.id]);
  const role = await writer.createRole(
    tenant.tenant.id,
    'Effective reader',
    'Fixture',
    op(),
  );
  const extraCode = 'foundation.fixture.evaluate';
  await migrator.query(
    "INSERT INTO \"authorization\".permission(code,owner_module,description) VALUES($1,'foundation','Discardable evaluator fixture')",
    [extraCode],
  );
  const grant = await writer.grantPermission(
    tenant.tenant.id,
    role.id,
    'foundation.probe.read',
    op(),
  );
  await writer.grantPermission(tenant.tenant.id, role.id, extraCode, op());
  const companyScope: Scope = { type: 'COMPANY', unitId: company.company.id },
    branchScope: Scope = { type: 'BRANCH', unitId: branch.branch.id },
    groupScope: Scope = { type: 'GROUP', unitId: tenant.group.id };
  let assignment = await writer.assign(
    tenant.tenant.id,
    a.memberships[0],
    role.id,
    companyScope,
    op(),
  );
  const decide = (
    scope: Scope = companyScope,
    permission = 'foundation.probe.read',
  ) =>
    factory.read(a.principal, tenant.tenant.id, (ctx) =>
      evaluator.can(ctx, permission, scope),
    );
  try {
    await t.test(
      'Access: verified principal, runtime context provenance, active source/transaction/GUC and lifecycle fail closed',
      async () => {
        assert.deepEqual(
          await evaluator.can(
            {} as AuthorizationContext,
            'foundation.probe.read',
            companyScope,
          ),
          { allowed: false, reason: 'UNAVAILABLE_CONTEXT' },
        );
        await assert.rejects(
          factory.read({ ...a.principal }, tenant.tenant.id, () => true),
          /Resource unavailable/,
        );
        await assert.rejects(factory.read(a.principal, 'invalid', () => true));
        await assert.rejects(
          factory.read(a.principal, foreign.tenant.id, () => true),
        );
        const unknown = await verifier.verify(await issuer.token(randomUUID()));
        await assert.rejects(
          factory.read(unknown, tenant.tenant.id, () => true),
        );
        let retained!: AuthorizationContext;
        await factory.read(a.principal, tenant.tenant.id, async (ctx) => {
          retained = ctx;
          assert.equal(
            (await evaluator.can(ctx, 'foundation.probe.read', companyScope))
              .allowed,
            true,
          );
          await ctx.manager.query(
            "SELECT set_config('innoview.tenant_id','',true)",
          );
          assert.equal(
            (await evaluator.can(ctx, 'foundation.probe.read', companyScope))
              .allowed,
            false,
          );
        });
        assert.equal(
          (await evaluator.can(retained, 'foundation.probe.read', companyScope))
            .allowed,
          false,
        );
        assert.deepEqual(await evaluator.permissionsFor(retained), []);
        const wrong = new AuthorizationEvaluator(
          auth,
          new MembershipsService(auth),
          new OrganizationsService(auth),
        );
        await factory.read(a.principal, tenant.tenant.id, async (ctx) =>
          assert.equal(
            (await wrong.can(ctx, 'foundation.probe.read', companyScope))
              .allowed,
            false,
          ),
        );
        await assert.rejects(
          factory.read(a.principal, tenant.tenant.id, (ctx) => {
            retained = ctx;
            throw new Error('rollback fixture');
          }),
        );
        assert.equal(
          (await evaluator.can(retained, 'foundation.probe.read', companyScope))
            .allowed,
          false,
        );
      },
    );
    await t.test(
      'Access: exact scopes, no GROUP/COMPANY inheritance, no grant for other identities/tenants or typed/malformed scope',
      async () => {
        assert.equal((await decide()).allowed, true);
        assert.equal((await decide(branchScope)).allowed, false);
        for (const scope of [
          groupScope,
          { type: 'COMPANY' as const, unitId: sibling.company.id },
          { type: 'COMPANY' as const, unitId: companyB.company.id },
          { type: 'GROUP' as const, unitId: company.company.id },
          { type: 'COMPANY' as const, unitId: 'bad' },
        ])
          assert.equal((await decide(scope)).allowed, false);
        assert.equal(
          (
            await factory.read(b.principal, tenant.tenant.id, (ctx) =>
              evaluator.can(ctx, 'foundation.probe.read', companyScope),
            )
          ).allowed,
          false,
        );
        await assert.rejects(
          factory.read(c.principal, tenant.tenant.id, () => true),
        );
        await factory.read(multi.principal, tenant.tenant.id, async (ctx) =>
          assert.deepEqual(
            await ctx.manager.query(
              'SELECT id FROM organizations.company WHERE tenant_id=$1',
              [foreign.tenant.id],
            ),
            [],
          ),
        );
        await writer.assign(
          tenant.tenant.id,
          a.memberships[0],
          role.id,
          groupScope,
          op(),
        );
        assert.equal((await decide(groupScope)).allowed, true);
        assert.equal((await decide(branchScope)).allowed, false);
        await writer.assign(
          tenant.tenant.id,
          a.memberships[0],
          role.id,
          branchScope,
          op(),
        );
        await writer.assign(
          tenant.tenant.id,
          a.memberships[0],
          role.id,
          { type: 'BRANCH', unitId: otherBranch.branch.id },
          op(),
        );
      },
    );
    await t.test(
      'Access: full-set differential oracle, scopes/can coherence, duplicated grants and bounded SQL query counts',
      async () => {
        const duplicate = await writer.createRole(
          tenant.tenant.id,
          'Duplicate reader',
          'Fixture',
          op(),
        );
        await writer.grantPermission(
          tenant.tenant.id,
          duplicate.id,
          'foundation.probe.read',
          op(),
        );
        await writer.assign(
          tenant.tenant.id,
          a.memberships[0],
          duplicate.id,
          companyScope,
          op(),
        );
        await factory.read(a.principal, tenant.tenant.id, async (ctx) => {
          const queries = candidateQueries(
            tenant.tenant.id,
            a.memberships[0],
            company.company.id,
          ).filter((q) => q.strategy === 'materialized');
          const expectedPermissions = await ctx.manager.query<
            { permission_id: string; code: string }[]
          >(
            queries.find((q) => q.name === 'permissions')!.sql,
            queries.find((q) => q.name === 'permissions')!.params,
          );
          const permissions = await evaluator.permissionsFor(ctx);
          assert.deepEqual(
            permissions,
            expectedPermissions
              .map((p) => ({ id: p.permission_id, code: p.code }))
              .sort((x, y) => x.code.localeCompare(y.code)),
          );
          const q = queries.find((q) => q.name === 'scopes')!,
            expectedScopes = await ctx.manager.query<
              { scope_type: Scope['type']; scope_unit_id: string }[]
            >(q.sql, q.params);
          const scopes = await evaluator.scopesFor(
            ctx,
            'foundation.probe.read',
          );
          assert.deepEqual(
            scopes,
            expectedScopes
              .map((s) => ({ type: s.scope_type, unitId: s.scope_unit_id }))
              .sort(
                (x, y) =>
                  x.type.localeCompare(y.type) ||
                  x.unitId.localeCompare(y.unitId),
              ),
          );
          for (const scope of scopes)
            assert.equal(
              (await evaluator.can(ctx, 'foundation.probe.read', scope))
                .allowed,
              true,
            );
          let count = 0;
          const logger = app.logger;
          const collector: Logger = {
            logQuery() {
              count++;
            },
            logQueryError() {},
            logQuerySlow() {},
            logSchemaBuild() {},
            logMigration() {},
            log() {},
          };
          app.logger = collector;
          try {
            await evaluator.permissionsFor(ctx);
            assert.equal(count, 2);
            count = 0;
            await evaluator.scopesFor(ctx, 'foundation.probe.read');
            assert.equal(count, 2);
          } finally {
            app.logger = logger;
          }
        });
        await writer.setRoleStatus(
          tenant.tenant.id,
          duplicate.id,
          'INACTIVE',
          op(),
        );
      },
    );
    await t.test(
      'Access: D-7 inactive role retains ACTIVE grants/assignment but denies, and grant/assignment revocation takes effect',
      async () => {
        await writer.setRoleStatus(tenant.tenant.id, role.id, 'INACTIVE', op());
        assert.equal((await decide()).allowed, false);
        const [stored] = await auth.transaction(async (m) => {
          await m.query("SELECT set_config('innoview.tenant_id',$1,true)", [
            tenant.tenant.id,
          ]);
          return m.query<{ status: string }[]>(
            'SELECT status FROM "authorization".role_assignment WHERE id=$1',
            [assignment.id],
          );
        });
        assert.equal(stored.status, 'ACTIVE');
        await writer.setRoleStatus(tenant.tenant.id, role.id, 'ACTIVE', op());
        assert.equal((await decide()).allowed, true);
        await writer.revokePermission(tenant.tenant.id, grant.id, op());
        assert.equal((await decide()).allowed, false);
        await writer.grantPermission(
          tenant.tenant.id,
          role.id,
          'foundation.probe.read',
          op(),
        );
        await writer.revokeAssignment(tenant.tenant.id, assignment.id, op());
        assert.equal((await decide()).allowed, false);
        assignment = await writer.assign(
          tenant.tenant.id,
          a.memberships[0],
          role.id,
          companyScope,
          op(),
        );
      },
    );
    await t.test(
      'Access: company/branch/group/tenant and archived ancestors invalidate effective descendants without deleting grants',
      async () => {
        for (const unit of [
          branch.branch.id,
          company.company.id,
          tenant.group.id,
        ]) {
          await orgs.setStatus(tenant.tenant.id, unit, 'INACTIVE', op());
          if (unit === tenant.group.id)
            await assert.rejects(decide(branchScope));
          else assert.equal((await decide(branchScope)).allowed, false);
          if (unit === company.company.id)
            assert.equal((await decide()).allowed, false);
          await orgs.setStatus(tenant.tenant.id, unit, 'ACTIVE', op());
        }
        await orgs.setStatus(tenant.tenant.id, null, 'INACTIVE', op());
        await assert.rejects(decide());
        await orgs.setStatus(tenant.tenant.id, null, 'ACTIVE', op());
        await orgs.setStatus(
          tenant.tenant.id,
          sibling.company.id,
          'ARCHIVED',
          op(),
        );
        assert.equal(
          (await decide({ type: 'BRANCH', unitId: otherBranch.branch.id }))
            .allowed,
          false,
        );
        const scopes = await factory.read(
          a.principal,
          tenant.tenant.id,
          (ctx) => evaluator.scopesFor(ctx, 'foundation.probe.read'),
        );
        assert.ok(!scopes.some((s) => s.unitId === otherBranch.branch.id));
      },
    );
    await t.test(
      'Access: deprecated known permission is NO_GRANT, unknown is internal-only and telemetry is once per context',
      async () => {
        await migrator.query(
          'UPDATE "authorization".permission SET status=\'DEPRECATED\' WHERE code=$1',
          [extraCode],
        );
        const lines: string[] = [];
        const original = console.info;
        console.info = (line: unknown) => {
          lines.push(String(line));
        };
        try {
          await factory.read(a.principal, tenant.tenant.id, async (ctx) => {
            assert.deepEqual(
              await evaluator.can(ctx, extraCode, companyScope),
              { allowed: false, reason: 'NO_GRANT' },
            );
            assert.deepEqual(await evaluator.scopesFor(ctx, extraCode), []);
            assert.ok(
              !(await evaluator.permissionsFor(ctx)).some(
                (p) => p.code === extraCode,
              ),
            );
            assert.deepEqual(
              await evaluator.can(
                ctx,
                'foundation.unknown.permission',
                companyScope,
              ),
              { allowed: false, reason: 'UNKNOWN_PERMISSION' },
            );
          });
        } finally {
          console.info = original;
        }
        assert.equal(
          lines.filter((l) => l.includes('DEPRECATED_PERMISSION_USED')).length,
          1,
        );
        assert.ok(lines.every((l) => !l.includes(extraCode)));
      },
    );
    await t.test(
      'Access: snapshot revocation, unchanged RBAC versions and subsequent reads; same physical pool clears LOCAL after commit/rollback',
      async () => {
        const versions = () =>
          app.query<unknown[]>(
            'SELECT revision FROM "authorization".catalog_version',
          );
        const tenantVersion = () =>
          auth.transaction(async (m) => {
            await m.query("SELECT set_config('innoview.tenant_id',$1,true)", [
              tenant.tenant.id,
            ]);
            return m.query<unknown[]>(
              'SELECT revision FROM "authorization".tenant_revision',
            );
          });
        const before = await versions(),
          revision = await tenantVersion();
        await factory.read(a.principal, tenant.tenant.id, async (ctx) => {
          assert.equal(
            (await evaluator.can(ctx, 'foundation.probe.read', companyScope))
              .allowed,
            true,
          );
          await members.revoke(tenant.tenant.id, a.identity, op());
          const projection = await appOrgs.authorizedCompanyProjection(
            tenant.tenant.id,
            company.company.id,
            ctx.manager,
          );
          assert.deepEqual(projection, {
            id: company.company.id,
            name: 'Effective company A',
          });
          assert.equal(
            (await evaluator.can(ctx, 'foundation.probe.read', companyScope))
              .allowed,
            true,
          );
        });
        await assert.rejects(decide());
        assert.deepEqual(await versions(), before);
        assert.deepEqual(await tenantVersion(), revision);
        const single = createDataSource('app', env);
        single.setOptions({ poolSize: 1 });
        await single.initialize();
        const sm = new MembershipsService(single),
          so = new OrganizationsService(single),
          si = new IdentityService(single),
          reads = new AuthorizationReads(
            single,
            new TenantReadTransactions(
              new IdentityReadTransactions(single, si),
              sm,
              so,
            ),
            sm,
          );
        try {
          const [pid] = await single.query<{ pid: number }[]>(
            'SELECT pg_backend_pid() AS pid',
          );
          for (const principal of [b.principal, multi.principal]) {
            await reads.read(principal, tenant.tenant.id, () => true);
            await assert.rejects(
              reads.read(principal, tenant.tenant.id, () => {
                throw new Error('rollback');
              }),
            );
            const [after] = await single.query<
              { pid: number; identity: string | null; tenant: string | null }[]
            >(
              "SELECT pg_backend_pid() AS pid,NULLIF(current_setting('innoview.user_identity_id',true),'') AS identity,NULLIF(current_setting('innoview.tenant_id',true),'') AS tenant",
            );
            assert.deepEqual(after, {
              pid: pid.pid,
              identity: null,
              tenant: null,
            });
          }
        } finally {
          await single.destroy();
        }
      },
    );
  } finally {
    await issuer.close();
    await auth.destroy();
    await member.destroy();
    await org.destroy();
  }
}
