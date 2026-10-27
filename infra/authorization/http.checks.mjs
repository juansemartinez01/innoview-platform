import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  initializeAuthorizationOperatorDataSource,
  initializeMembershipOperatorDataSource,
  initializeOrganizationsOperatorDataSource,
  initializeOrganizationsProvisionerDataSource,
} from '../../apps/api/dist/persistence/data-sources.js';
import { OrganizationsService } from '../../apps/api/dist/organizations/organizations.service.js';
import { MembershipsService } from '../../apps/api/dist/memberships/memberships.service.js';
import { AuthorizationService } from '../../apps/api/dist/authorization/authorization.service.js';

export async function verifyAccessHttp(
  t,
  { env, login, Browser, migrator, sensitive },
) {
  const sources = await Promise.all([
    initializeAuthorizationOperatorDataSource(env),
    initializeMembershipOperatorDataSource(env),
    initializeOrganizationsOperatorDataSource(env),
    initializeOrganizationsProvisionerDataSource(env),
  ]);
  const [auth, member, org, provisioner] = sources,
    orgs = new OrganizationsService(org, provisioner),
    members = new MembershipsService(member);
  const writer = new AuthorizationService(auth, {
    membershipActive: (tenant, id) =>
      members.activeMembershipReference(tenant, id),
    scopeAvailable: (tenant, id, type) =>
      orgs.availableScopeReference(tenant, id, type),
  });
  const op = () => ({
    actor: 'fixture:http-authorization',
    actorType: 'SYSTEM',
    reason: 'Discardable real JWT demonstration',
    requestId: randomUUID(),
  });
  try {
    const users = [];
    for (const username of [
      'runtime-test',
      'runtime-second',
      'runtime-legacy',
    ]) {
      const { tokens } = await login(
        new Browser(env.PORTAL_ORIGIN),
        undefined,
        undefined,
        username,
        true,
      );
      sensitive.push(
        tokens.access_token,
        tokens.refresh_token,
        tokens.id_token,
      );
      const response = await fetch(env.AUTH_API_ORIGIN + '/identity/me', {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      assert.equal(response.status, 200);
      users.push({
        token: tokens.access_token,
        identity: (await response.json()).id,
      });
    }
    const tenant = await orgs.createTenant(
        'HTTP effective tenant',
        'HTTP effective group',
        op(),
      ),
      foreign = await orgs.createTenant(
        'HTTP other tenant',
        'HTTP other group',
        op(),
      );
    const company = await orgs.createCompany(
      tenant.tenant.id,
      tenant.group.id,
      'AUTHORIZED TECHNICAL COMPANY',
      null,
      op(),
    );
    const sibling = await orgs.createCompany(
      tenant.tenant.id,
      tenant.group.id,
      'PRIVATE SIBLING COMPANY',
      null,
      op(),
    );
    const ma = await members.register(
      tenant.tenant.id,
      users[0].identity,
      op(),
    );
    await members.register(tenant.tenant.id, users[1].identity, op());
    await members.register(foreign.tenant.id, users[2].identity, op());
    const role = await writer.createRole(
      tenant.tenant.id,
      'HTTP technical reader',
      'No real users/volumes',
      op(),
    );
    await writer.grantPermission(
      tenant.tenant.id,
      role.id,
      'foundation.probe.read',
      op(),
    );
    await writer.assign(
      tenant.tenant.id,
      ma.membership.id,
      role.id,
      { type: 'COMPANY', unitId: company.company.id },
      op(),
    );
    const path = (candidate = tenant.tenant.id, unit = company.company.id) =>
      `${env.AUTH_API_ORIGIN}/authorization/demo/tenants/${candidate}/companies/${unit}`;
    const request = (user = 0, url = path()) =>
      fetch(url, {
        headers: {
          authorization: `Bearer ${users[user].token}`,
          'x-correlation-id': 'hostile-correlation',
        },
      });
    const denied = async (response, status) => {
      assert.equal(response.status, status);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const value = await response.json();
      assert.equal(
        value.correlationId,
        response.headers.get('x-correlation-id'),
      );
      assert.match(value.correlationId, /^[a-f0-9-]{36}$/);
      const text = JSON.stringify(value);
      assert.ok(
        !text.includes(company.company.id) &&
          !text.includes('AUTHORIZED TECHNICAL COMPANY') &&
          !text.includes('PRIVATE SIBLING') &&
          !/SQLSTATE|tenant_id|membership_id|Row.Level|stack/i.test(text),
      );
      return value.message;
    };
    await t.test(
      'RBAC HTTP: real Keycloak JWT A allows minimal Company DTO; valid member B lacks permission; foreign tenant C denied',
      async () => {
        const allowed = await request();
        assert.equal(allowed.status, 200);
        assert.equal(allowed.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await allowed.json(), {
          id: company.company.id,
          name: 'AUTHORIZED TECHNICAL COMPANY',
        });
        await denied(await request(1), 403);
        const foreignMessage = await denied(await request(2), 404);
        assert.equal(
          await denied(await request(2, path(randomUUID())), 404),
          foreignMessage,
        );
        await denied(await fetch(path()), 401);
        await denied(
          await fetch(path(), {
            headers: { authorization: 'Bearer invalid.jwt.signature' },
          }),
          401,
        );
        assert.equal(
          await denied(
            await request(0, path(tenant.tenant.id, sibling.company.id)),
            403,
          ),
          await denied(
            await request(0, path(tenant.tenant.id, randomUUID())),
            403,
          ),
        );
        await denied(
          await request(0, path() + '?identityId=' + users[1].identity),
          404,
        );
        await denied(await request(0, path('malformed')), 404);
      },
    );
    await t.test(
      'RBAC HTTP: inactive role, unavailable unit/ancestor/tenant and deprecated Permission deny without exposing Company data',
      async () => {
        const lock = migrator.createQueryRunner();
        await lock.connect();
        await lock.startTransaction();
        try {
          await lock.query(
            'LOCK TABLE "authorization".role IN ACCESS EXCLUSIVE MODE',
          );
          const unavailable = await request();
          assert.equal(unavailable.headers.get('retry-after'), '1');
          await denied(unavailable, 503);
        } finally {
          await lock.rollbackTransaction();
          await lock.release();
        }
        await writer.setRoleStatus(tenant.tenant.id, role.id, 'INACTIVE', op());
        await denied(await request(), 403);
        await writer.setRoleStatus(tenant.tenant.id, role.id, 'ACTIVE', op());
        await orgs.setStatus(
          tenant.tenant.id,
          company.company.id,
          'INACTIVE',
          op(),
        );
        await denied(await request(), 403);
        await orgs.setStatus(
          tenant.tenant.id,
          company.company.id,
          'ACTIVE',
          op(),
        );
        await orgs.setStatus(
          tenant.tenant.id,
          tenant.group.id,
          'INACTIVE',
          op(),
        );
        await denied(await request(), 404);
        await orgs.setStatus(tenant.tenant.id, tenant.group.id, 'ACTIVE', op());
        await orgs.setStatus(tenant.tenant.id, null, 'INACTIVE', op());
        await denied(await request(), 404);
        await orgs.setStatus(tenant.tenant.id, null, 'ACTIVE', op());
        assert.equal((await request()).status, 200);
        await migrator.query(
          "UPDATE \"authorization\".permission SET status='DEPRECATED' WHERE code='foundation.probe.read'",
        );
        await denied(await request(), 403);
        assert.match(env.DB_NAME, /^innoview_test_/);
        await assert.rejects(
          migrator.query(
            "UPDATE \"authorization\".permission SET status='ACTIVE' WHERE code='foundation.probe.read'",
          ),
          (error) => error.code === '23514',
        );
        await members.revoke(tenant.tenant.id, users[0].identity, op());
        await denied(await request(), 404);
      },
    );
  } finally {
    await Promise.all(sources.map((s) => s.destroy()));
  }
}
