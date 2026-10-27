const organizationOperation = () => ({
  actor: 'fixture:trusted-operator',
  actorType: 'SYSTEM',
  reason: 'Discardable integration fixture',
  requestId: randomUUID(),
});
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { verifyContextBrowser } from './context.browser.mjs';
const requireApi = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);
const pg = requireApi('pg');

// Called only inside the existing generated PostgreSQL + Keycloak fixture.
// No development users, tenants, volumes or credentials are modified.
export async function verifyContext(t, h) {
  const {
    env,
    login,
    Browser,
    stores,
    storedSession,
    migrator,
    bootstrap,
    admin,
    userPassword,
    sensitive,
  } = h;
  const {
    createDataSource,
    initializeMembershipOperatorDataSource,
    initializeOrganizationsOperatorDataSource,
    initializeOrganizationsProvisionerDataSource,
  } = await import('../../apps/api/dist/persistence/data-sources.js');
  const { OrganizationsService } =
    await import('../../apps/api/dist/organizations/organizations.service.js');
  const { MembershipsService } =
    await import('../../apps/api/dist/memberships/memberships.service.js');
  const source = createDataSource('app', env);
  await source.initialize();
  const operator = await initializeMembershipOperatorDataSource(env);
  const organizationOperator =
    await initializeOrganizationsOperatorDataSource(env);
  const provisioner = await initializeOrganizationsProvisionerDataSource(env);
  const organization = new OrganizationsService(
    organizationOperator,
    provisioner,
  );
  const membership = new MembershipsService(operator);
  const browsers = [];
  const operation = () => ({
    actor: 'fixture:context-operator',
    reason: 'Disposable context test',
    requestId: randomUUID(),
  });
  try {
    const first = new Browser(env.PORTAL_ORIGIN);
    browsers.push(first);
    await login(first);
    const second = new Browser(env.PORTAL_ORIGIN);
    browsers.push(second);
    await login(second, undefined, undefined, 'runtime-second');
    const empty = new Browser(env.PORTAL_ORIGIN);
    browsers.push(empty);
    await login(empty, undefined, undefined, 'runtime-legacy');
    const identityA = (await first.session()).identity.id;
    const identityB = (await second.session()).identity.id;
    const a = await organization.createTenant(
      'Context tenant A',
      'Group A',
      organizationOperation(),
    );
    const b = await organization.createTenant(
      'Context tenant B',
      'Group B',
      organizationOperation(),
    );
    const c = await organization.createTenant(
      'Context foreign tenant C',
      'Group C',
      organizationOperation(),
    );
    const company = await organization.createCompany(
      a.tenant.id,
      a.group.id,
      'Private company A',
      undefined,
      organizationOperation(),
    );
    await organization.createBranch(
      a.tenant.id,
      company.company.id,
      'Private branch A',
      organizationOperation(),
    );
    await membership.register(a.tenant.id, identityA, operation());
    await membership.register(b.tenant.id, identityA, operation());
    await membership.register(c.tenant.id, identityB, operation());
    const payload = stores[0].unseal(await storedSession(first, 0));
    sensitive.push(payload.access, payload.refresh, payload.idToken);
    const api = async (path, token = payload.access, body) =>
      fetch(`${env.AUTH_API_ORIGIN}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const collect = async (response) => {
      const text = await response.text();
      first.responses.push(text);
      assert.ok(
        !/"(?:access_token|refresh_token|id_token|access|refresh|encrypted)"\s*:/.test(
          text,
        ),
      );
      return JSON.parse(text);
    };
    const view = async (browser = first) => {
      const response = await browser.request('/auth/context');
      assert.equal(response.status, 200);
      return collect(response);
    };
    const post = async (path, tenantId, revision, browser = first) =>
      browser.post(path, (await browser.session()).csrf, {
        ...(tenantId ? { tenantId } : {}),
        revision: String(revision),
      });
    const select = async (id, revision, browser = first) =>
      post('/auth/context/select', id, revision, browser);

    await t.test(
      'Context: own active options only, no private organization data or identity substitution',
      async () => {
        const response = await api('/context/options');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const result = await collect(response);
        assert.deepEqual(
          new Set(result.options.map((o) => o.id)),
          new Set([a.tenant.id, b.tenant.id]),
        );
        for (const option of result.options) {
          assert.deepEqual(Object.keys(option).sort(), ['group', 'id', 'name']);
          assert.deepEqual(Object.keys(option.group).sort(), ['id', 'name']);
        }
        assert.equal(
          (await api(`/context/options?user_identity_id=${identityB}`)).status,
          400,
        );
        assert.equal(
          (
            await api('/context/validate', payload.access, {
              tenantId: a.tenant.id,
              user_identity_id: identityB,
            })
          ).status,
          400,
        );
        assert.deepEqual((await view(empty)).options, []);
        assert.deepEqual(
          (await view(second)).options.map((o) => o.id),
          [c.tenant.id],
        );
        assert.equal((await api('/companies')).status, 404);
        assert.equal(
          (await api(`/organizations/tenants/${a.tenant.id}`)).status,
          404,
        );
      },
    );
    await t.test(
      'RLS runtime: concurrent verified JWT identities and direct unfiltered application SQL stay isolated',
      async () => {
        const other = stores[0].unseal(await storedSession(second, 0));
        sensitive.push(other.access, other.refresh, other.idToken);
        await Promise.all(
          Array.from({ length: 24 }, async (_, index) => {
            const useA = index % 2 === 0;
            const response = await api(
              '/context/options',
              useA ? payload.access : other.access,
            );
            assert.equal(response.status, 200);
            const body = await collect(response);
            assert.deepEqual(
              new Set(body.options.map((item) => item.id)),
              new Set(useA ? [a.tenant.id, b.tenant.id] : [c.tenant.id]),
            );
          }),
        );
        assert.deepEqual(
          await source.query('SELECT * FROM memberships.membership'),
          [],
        );
        await source.transaction(async (manager) => {
          // Test fixture UUID obtained from authenticated /auth/session, not a new
          // HTTP parameter or a production authority for establishing context.
          await manager.query(
            "SELECT set_config('innoview.user_identity_id',$1,true)",
            [identityA],
          );
          const rows = await manager.query(
            'SELECT user_identity_id FROM memberships.membership',
          );
          assert.equal(rows.length, 2);
          assert.ok(rows.every((row) => row.user_identity_id === identityA));
          assert.deepEqual(
            await manager.query(
              'SELECT * FROM memberships.membership WHERE user_identity_id=$1',
              [identityB],
            ),
            [],
          );
        });
        assert.deepEqual(
          await source.query('SELECT * FROM memberships.membership'),
          [],
        );
      },
    );
    await t.test(
      'Context: real Chromium Portal selector changes, persists, clears and respects empty/Control Center views',
      async () => {
        await verifyContextBrowser({ env, userPassword, a, b });
      },
    );
    await t.test(
      'Context: invalid JWT is 401, Control Center has no selector, unknown local principal is not registered',
      async () => {
        for (const token of ['', 'invalid.token.signature']) {
          assert.equal((await api('/context/options', token)).status, 401);
          assert.equal(
            (await api('/context/validate', token, { tenantId: a.tenant.id }))
              .status,
            401,
          );
        }
        assert.equal((await h.control.request('/auth/context')).status, 404);
        const controlPayload = stores[1].unseal(
          await storedSession(h.control, 1),
        );
        assert.equal(
          (await api('/context/options', controlPayload.access)).status,
          403,
        );
        await admin('realms/innoview/users', {
          method: 'POST',
          body: {
            username: 'context-unregistered',
            firstName: 'Context',
            lastName: 'Test',
            email: 'context-unregistered@example.invalid',
            emailVerified: true,
            enabled: true,
            credentials: [
              { type: 'password', value: userPassword, temporary: false },
            ],
          },
        });
        const unregistered = new Browser(env.PORTAL_ORIGIN);
        const { tokens } = await login(
          unregistered,
          undefined,
          undefined,
          'context-unregistered',
          true,
        );
        sensitive.push(
          tokens.access_token,
          tokens.refresh_token,
          tokens.id_token,
        );
        const count = (
          await migrator.query(
            'SELECT count(*)::int AS n FROM identity.user_identity',
          )
        )[0].n;
        assert.deepEqual(
          await collect(await api('/context/options', tokens.access_token)),
          { options: [] },
        );
        assert.equal(
          (
            await api('/context/validate', tokens.access_token, {
              tenantId: a.tenant.id,
            })
          ).status,
          404,
        );
        assert.equal(
          (
            await migrator.query(
              'SELECT count(*)::int AS n FROM identity.user_identity',
            )
          )[0].n,
          count,
        );
      },
    );
    await t.test(
      'Context: select, change and clear persist only in Portal server session; foreign and malformed UUIDs fail',
      async () => {
        let current = await view();
        assert.equal(current.selected, null);
        for (const tenant of [a, b]) {
          const response = await select(tenant.tenant.id, current.revision);
          assert.equal(response.status, 200);
          await collect(response);
          current = await view();
          assert.equal(current.selected.id, tenant.tenant.id);
          const reload = new Browser(env.PORTAL_ORIGIN);
          reload.jar = new Map(first.jar);
          assert.equal((await view(reload)).selected.id, tenant.tenant.id);
          assert.ok(
            ![...first.jar.values()].some((value) =>
              value.includes(tenant.tenant.id),
            ),
          );
          const row = await storedSession(first, 0);
          assert.equal(row.selected_tenant_id, tenant.tenant.id);
          assert.equal(stores[0].unseal(row).tenantId, undefined);
        }
        const statuses = [];
        for (const id of [c.tenant.id, randomUUID()]) {
          const response = await api('/context/validate', payload.access, {
            tenantId: id,
          });
          const body = await collect(response);
          assert.equal(
            body.correlationId,
            response.headers.get('x-correlation-id'),
          );
          delete body.correlationId;
          statuses.push(body);
          assert.equal(response.status, 404);
          assert.equal((await select(id, current.revision)).status, 404);
        }
        assert.deepEqual(statuses[0], statuses[1]);
        assert.equal(
          (await select('not-a-uuid', current.revision)).status,
          400,
        );
        assert.equal(
          (
            await api('/context/validate', payload.access, {
              tenantId: 'malformed',
            })
          ).status,
          400,
        );
        assert.equal(
          (await post('/auth/context/clear', null, current.revision)).status,
          200,
        );
        assert.equal((await view()).selected, null);
        first.jar.set('tenant_id', c.tenant.id);
        assert.equal((await view()).selected, null);
        const forged = new Browser(env.PORTAL_ORIGIN);
        forged.jar.set(stores[0].config.cookie.cookieName, c.tenant.id);
        assert.equal((await forged.request('/auth/context')).status, 401);
      },
    );
    await t.test(
      'Context: CSRF, Origin, duplicate fields and stale revisions cannot modify selection',
      async () => {
        const current = await view();
        const csrf = (await first.session()).csrf;
        const fields = {
          tenantId: a.tenant.id,
          revision: String(current.revision),
        };
        for (const path of ['/auth/context/select', '/auth/context/clear']) {
          const data = path.endsWith('select')
            ? fields
            : { revision: String(current.revision) };
          assert.equal((await first.post(path, 'wrong', data)).status, 403);
          assert.equal(
            (await first.post(path, csrf, data, 'https://foreign.invalid'))
              .status,
            403,
          );
        }
        const duplicate = new URLSearchParams({ csrf, ...fields });
        duplicate.append('tenantId', b.tenant.id);
        assert.equal(
          (
            await first.request('/auth/context/select', {
              method: 'POST',
              headers: { origin: env.PORTAL_ORIGIN },
              body: duplicate,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await first.post('/auth/context/select', csrf, {
              ...fields,
              user_identity_id: identityB,
            })
          ).status,
          400,
        );
        assert.equal((await select(a.tenant.id, current.revision)).status, 200);
        assert.equal((await select(b.tenant.id, current.revision)).status, 409);
        assert.equal((await view()).selected.id, a.tenant.id);
      },
    );
    await t.test(
      'Context: concurrent selection and genuine refresh preserve tokens and do not lose selection changes',
      async () => {
        let current = await view();
        const replies = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            select(i % 2 ? a.tenant.id : b.tenant.id, current.revision),
          ),
        );
        assert.equal(replies.filter((r) => r.status === 200).length, 1);
        assert.equal(replies.filter((r) => r.status === 409).length, 7);
        const old = await storedSession(first, 0);
        const oldPayload = stores[0].unseal(old);
        current = await view();
        await stores[0].source.query(
          'UPDATE portal_sessions.sessions SET access_until=now() WHERE id_hash=$1',
          [old.id_hash],
        );
        const [changed, ...sessions] = await Promise.all([
          select(b.tenant.id, current.revision),
          ...Array.from({ length: 6 }, () => first.session()),
        ]);
        assert.equal(changed.status, 200);
        assert.ok(sessions.every((s) => s.authenticated));
        const next = await storedSession(first, 0);
        const nextPayload = stores[0].unseal(next);
        sensitive.push(
          nextPayload.access,
          nextPayload.refresh,
          nextPayload.idToken,
        );
        assert.equal(next.version, old.version + 1);
        assert.ok(
          nextPayload.refresh !== oldPayload.refresh,
          'A genuine refresh rotates once',
        );
        assert.equal(next.selected_tenant_id, b.tenant.id);
        assert.equal(next.context_revision, current.revision + 1);
        assert.equal((await view()).selected.id, b.tenant.id);
        const open = await bootstrap.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND state='idle in transaction'",
          [env.DB_NAME],
        );
        assert.equal(open.rowCount, 0);
      },
    );
    await t.test(
      'Context: inactive group/OU or tenant invalidates selection; archived tenant is unavailable',
      async () => {
        let current = await view();
        assert.equal(current.selected.id, b.tenant.id);
        await organization.setStatus(
          b.tenant.id,
          b.group.id,
          'INACTIVE',
          organizationOperation(),
        );
        current = await view();
        assert.equal(current.selected, null);
        assert.equal(current.invalidated, true);
        assert.ok(!current.options.some((o) => o.id === b.tenant.id));
        assert.equal((await select(b.tenant.id, current.revision)).status, 404);
        await organization.setStatus(
          b.tenant.id,
          b.group.id,
          'ACTIVE',
          organizationOperation(),
        );
        await organization.setStatus(
          b.tenant.id,
          null,
          'INACTIVE',
          organizationOperation(),
        );
        current = await view();
        assert.ok(!current.options.some((o) => o.id === b.tenant.id));
        assert.equal((await select(b.tenant.id, current.revision)).status, 404);
        await organization.setStatus(
          b.tenant.id,
          null,
          'ACTIVE',
          organizationOperation(),
        );
        current = await view();
        assert.equal((await select(a.tenant.id, current.revision)).status, 200);
        current = await view();
        await organization.setStatus(
          a.tenant.id,
          a.group.id,
          'INACTIVE',
          organizationOperation(),
        );
        assert.equal((await select(a.tenant.id, current.revision)).status, 404);
        assert.equal((await storedSession(first, 0)).selected_tenant_id, null);
        await organization.setStatus(
          a.tenant.id,
          a.group.id,
          'ACTIVE',
          organizationOperation(),
        );
        await organization.setStatus(
          b.tenant.id,
          null,
          'ARCHIVED',
          organizationOperation(),
        );
        current = await view();
        assert.ok(!current.options.some((o) => o.id === b.tenant.id));
        assert.equal((await select(b.tenant.id, current.revision)).status, 404);
      },
    );
    await t.test(
      'Context: later membership revocation clears persisted selection on next check and cannot be authority',
      async () => {
        let current = await view();
        assert.equal((await select(a.tenant.id, current.revision)).status, 200);
        await membership.revoke(a.tenant.id, identityA, operation());
        current = await view();
        assert.equal(current.selected, null);
        assert.equal(current.invalidated, true);
        assert.deepEqual(current.options, []);
        assert.equal((await storedSession(first, 0)).selected_tenant_id, null);
        assert.equal((await select(a.tenant.id, current.revision)).status, 404);
        assert.equal(
          (
            await api('/context/validate', payload.access, {
              tenantId: a.tenant.id,
            })
          ).status,
          404,
        );
        assert.equal(
          (await api(`/companies/${company.company.id}`)).status,
          404,
        );
        assert.equal((await api('/auth/me')).status, 200); // authentication survives revocation
      },
    );
    await t.test(
      'Context: logout and racing updates cannot resurrect server selection; CC schema remains unchanged',
      async () => {
        let current = await view(second);
        assert.equal(
          (await select(c.tenant.id, current.revision, second)).status,
          200,
        );
        const row = await storedSession(second, 0);
        const csrf = (await second.session()).csrf;
        const outcomes = await Promise.all([
          second.post('/auth/logout', csrf),
          select(c.tenant.id, current.revision + 1, second),
        ]);
        assert.ok(outcomes.some((r) => r.status === 303));
        assert.equal((await second.request('/auth/context')).status, 401);
        assert.equal(
          (
            await stores[0].source.query(
              'SELECT 1 FROM portal_sessions.sessions WHERE id_hash=$1',
              [row.id_hash],
            )
          ).length,
          0,
        );
        const columns = await migrator.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema='control_sessions' AND column_name IN ('selected_tenant_id','context_revision')",
        );
        assert.equal(columns.length, 0);
        const client = new pg.Client({
          host: env.DB_HOST,
          port: Number(env.DB_PORT),
          database: env.DB_NAME,
          user: env.DB_APP_USER,
          password: env.DB_APP_PASSWORD,
        });
        await client.connect();
        try {
          await assert.rejects(
            client.query('SELECT * FROM portal_sessions.sessions'),
            (error) => error.code === '42501',
          );
        } finally {
          await client.end();
        }
      },
    );
  } finally {
    h.portal.responses.push(
      ...browsers.flatMap((browser) => browser.responses),
    );
    await provisioner.destroy();
    await organizationOperator.destroy();
    await operator.destroy();
    await source.destroy();
  }
}
