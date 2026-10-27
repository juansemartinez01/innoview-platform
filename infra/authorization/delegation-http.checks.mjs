import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Runs before the terminal deprecation partition, on disposable Keycloak users.
export async function verifyDelegationHttp(
  t,
  { env, users, writer, orgs, members },
) {
  const op = () => ({
    actor: 'fixture:innoview-bootstrap',
    actorType: 'INNOVIEW_OPERATOR',
    reason: 'Discardable delegated HTTP verification',
    requestId: randomUUID(),
  });
  const a = await orgs.createTenant(
    'Delegated HTTP',
    'Delegated HTTP group',
    op(),
  );
  const b = await orgs.createTenant(
    'Foreign delegated HTTP',
    'Foreign group',
    op(),
  );
  const company = await orgs.createCompany(
    a.tenant.id,
    a.group.id,
    'Delegated company',
    null,
    op(),
  );
  const actor = await members.register(a.tenant.id, users[0].identity, op());
  const target = await members.register(a.tenant.id, users[1].identity, op());
  await members.register(b.tenant.id, users[2].identity, op());
  const admin = await writer.createRole(
    a.tenant.id,
    'Bootstrap admin',
    'Technical fixture',
    op(),
  );
  const role = await writer.createRole(
    a.tenant.id,
    'Ordinary reader',
    'Technical fixture',
    op(),
  );
  await writer.grantPermission(
    a.tenant.id,
    admin.id,
    'authorization.assignment.grant',
    op(),
  );
  await writer.grantPermission(
    a.tenant.id,
    admin.id,
    'foundation.probe.read',
    op(),
  );
  await writer.grantPermission(
    a.tenant.id,
    role.id,
    'foundation.probe.read',
    op(),
  );
  const scope = { type: 'COMPANY', unitId: company.company.id };
  const authority = await writer.assign(
    a.tenant.id,
    actor.membership.id,
    admin.id,
    scope,
    op(),
    'GRANT_TENANT_ADMIN',
  );
  const body = {
    requestId: randomUUID(),
    membershipId: target.membership.id,
    roleId: role.id,
    scopeType: 'COMPANY',
    scopeUnitId: scope.unitId,
    reason: 'Explicit human delegation',
  };
  const send = (token = users[0].token, value = body, tenant = a.tenant.id) =>
    fetch(env.AUTH_API_ORIGIN + '/admin/role-assignments', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(value),
    });
  await t.test(
    '[HTTP Keycloak JWT] Delegated A assigns, replays, and B receives only the exact ordinary scope',
    async () => {
      const first = await send();
      assert.equal(first.status, 201);
      assert.equal(first.headers.get('cache-control'), 'no-store');
      const dto = await first.json();
      assert.deepEqual(Object.keys(dto).sort(), ['id', 'status']);
      assert.equal(dto.status, 'ACTIVE');
      assert.deepEqual(await (await send()).json(), dto);
      const allowed = await fetch(
        `${env.AUTH_API_ORIGIN}/authorization/demo/tenants/${a.tenant.id}/companies/${scope.unitId}`,
        { headers: { authorization: `Bearer ${users[1].token}` } },
      );
      assert.equal(allowed.status, 200);
    },
  );
  await t.test(
    '[HTTP Keycloak JWT] No authority, reserved role, foreign tenant, invalid JWT and request conflict are safe',
    async () => {
      for (const [token, value, tenant, status] of [
        [
          users[1].token,
          { ...body, requestId: randomUUID() },
          a.tenant.id,
          403,
        ],
        [
          users[0].token,
          { ...body, requestId: randomUUID(), roleId: admin.id },
          a.tenant.id,
          403,
        ],
        [
          users[2].token,
          { ...body, requestId: randomUUID() },
          a.tenant.id,
          404,
        ],
        ['', body, a.tenant.id, 401],
        ['invalid', body, a.tenant.id, 401],
        [
          users[0].token,
          { ...body, reason: 'Altered request' },
          a.tenant.id,
          409,
        ],
        [
          users[0].token,
          { ...body, actor: users[1].identity },
          a.tenant.id,
          404,
        ],
      ]) {
        const response = await send(token, value, tenant);
        assert.equal(response.status, status);
        const json = await response.json();
        assert.ok(json.correlationId);
        assert.equal(
          response.headers.get('x-correlation-id'),
          json.correlationId,
        );
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(Object.keys(json).sort(), [
          'correlationId',
          'error',
          'message',
          'statusCode',
        ]);
      }
    },
  );
  await t.test(
    '[HTTP Keycloak JWT] Revoked administrative authority denies identical replay without reexecution',
    async () => {
      await writer.revokeAssignment(a.tenant.id, authority.id, op());
      assert.equal((await send()).status, 403);
    },
  );
}
