const organizationOperation = () => ({
  actor: 'fixture:trusted-operator',
  actorType: 'SYSTEM',
  reason: 'Discardable integration fixture',
  requestId: randomUUID(),
});
import assert from 'node:assert/strict';
import { verifyContext } from './context.checks.mjs';
import { verifyAccessHttp } from '../authorization/http.checks.mjs';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import policy from '../../apps/api/src/runtime-environment.policy.json' with { type: 'json' };
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { decodeJwt, generateKeyPair, SignJWT } from 'jose';
import { administrator } from '../keycloak/admin.mjs';
import {
  configuration as keycloakConfiguration,
  desiredRealm,
} from '../keycloak/contract.mjs';

const requireApi = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);
const pg = requireApi('pg');
const requireBff = createRequire(
  new URL('../../packages/identity-bff/package.json', import.meta.url),
);
const { unsealData, sealData } = requireBff('iron-session');
const { provisionDatabase } =
  await import('../../apps/api/dist/persistence/provision.js');
const {
  createDataSource,
  initializeOrganizationsOperatorDataSource,
  initializeOrganizationsProvisionerDataSource,
} = await import('../../apps/api/dist/persistence/data-sources.js');
const { Store, hash } =
  await import('../../packages/identity-bff/dist/store.js');
const { configuration } =
  await import('../../packages/identity-bff/dist/config.js');
const root = fileURLToPath(new URL('../../', import.meta.url));
const secret = () => randomBytes(32).toString('hex');

class Browser {
  jar = new Map();
  responses = [];
  idpCookies = new Map();
  constructor(origin) {
    this.origin = origin;
  }
  async request(path, options = {}) {
    const response = await fetch(new URL(path, this.origin), {
      redirect: 'manual',
      signal: AbortSignal.timeout(90000),
      ...options,
      headers: {
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...options.headers,
      },
    });
    for (const line of response.headers.getSetCookie()) {
      assert.match(line, /HttpOnly/i);
      assert.match(line, /SameSite=Lax/i);
      assert.match(line, /Path=\//i);
      const pair = line.split(';')[0];
      const at = pair.indexOf('=');
      if (pair.slice(at + 1))
        this.jar.set(pair.slice(0, at), pair.slice(at + 1));
      else this.jar.delete(pair.slice(0, at));
    }
    return response;
  }
  async session() {
    const response = await this.request('/auth/session');
    assert.equal(response.status, 200);
    const text = await response.text();
    this.responses.push(text);
    return JSON.parse(text);
  }
  async post(path, csrf, extra = {}, origin = this.origin) {
    return this.request(path, {
      method: 'POST',
      headers: { origin },
      body: new URLSearchParams({ csrf, ...extra }),
    });
  }
}

await test(
  'runtime BFF + NestJS against disposable PostgreSQL and Keycloak (no business authorization)',
  { timeout: 240000 },
  async (t) => {
    const kc = keycloakConfiguration(process.env, true);
    const admin = await administrator(kc);
    assert.equal(
      (await admin('realms/innoview')).status,
      404,
      'Existing realm must be preserved: restart only the disposable fixture',
    );
    assert.ok(
      process.env.TEST_POSTGRES_PASSWORD &&
        process.env.TEST_DB_PORT &&
        process.env.TEST_DB_HOST,
    );
    assert.notEqual(process.env.TEST_DB_PORT, process.env.DB_PORT);
    const suffix = randomUUID().replaceAll('-', '');
    const database = `innoview_test_${suffix}`;
    const env = {
      ...process.env,
      NODE_ENV: 'development',
      AUTH_ENV: 'development',
      AUTH_ALLOW_HTTP: 'true',
      OIDC_ISSUER: kc.issuer,
      PORTAL_ORIGIN: 'http://127.0.0.1:13000',
      CONTROL_ORIGIN: 'http://127.0.0.1:13001',
      AUTH_API_ORIGIN: 'http://127.0.0.1:13002',
      API_PORT: '13002',
      DB_HOST: process.env.TEST_DB_HOST,
      DB_PORT: process.env.TEST_DB_PORT,
      DB_NAME: database,
      DB_SSL: 'disable',
      DB_BOOTSTRAP_USER: 'test_bootstrap',
      PLATFORM_POSTGRES_PASSWORD: process.env.TEST_POSTGRES_PASSWORD,
      DB_APP_USER: `test_app_${suffix}`,
      DB_APP_PASSWORD: secret(),
      DB_MIGRATOR_USER: `test_migrator_${suffix}`,
      DB_MIGRATOR_PASSWORD: secret(),
      DB_PORTAL_USER: `test_portal_${suffix}`,
      DB_PORTAL_PASSWORD: secret(),
      DB_CONTROL_USER: `test_control_${suffix}`,
      DB_CONTROL_PASSWORD: secret(),
      DB_MEMBERSHIP_USER: `test_membership_${suffix}`,
      DB_MEMBERSHIP_PASSWORD: secret(),
      DB_ORGANIZATIONS_USER: `test_organizations_${suffix}`,
      DB_ORGANIZATIONS_PASSWORD: secret(),
      DB_AUTHORIZATION_USER: `test_authorization_${suffix}`,
      DB_AUTHORIZATION_PASSWORD: secret(),
      DB_ORGANIZATIONS_PROVISIONER_USER: `test_org_provisioner_${suffix}`,
      DB_ORGANIZATIONS_PROVISIONER_PASSWORD: secret(),
      DB_DIRECTORY_MAINTENANCE_USER: `test_directory_${suffix}`,
      DB_DIRECTORY_MAINTENANCE_PASSWORD: secret(),
      PORTAL_COOKIE_PASSWORD: secret(),
      PORTAL_TOKEN_PASSWORD: secret(),
      CONTROL_COOKIE_PASSWORD: secret(),
      CONTROL_TOKEN_PASSWORD: secret(),
      NEXT_TELEMETRY_DISABLED: '1',
      AUTH_TEST_ARTIFACTS: 'true',
    };
    const bootstrap = new pg.Client({
      host: env.DB_HOST,
      port: Number(env.DB_PORT),
      user: 'test_bootstrap',
      password: env.PLATFORM_POSTGRES_PASSWORD,
      database: 'postgres',
    });
    const children = [];
    const logs = [];
    const stores = [];
    const sensitive = [];
    let created = false;
    let realmCreated = false;
    let migrator;
    let membershipObserver;
    function runtimeKeys(output, prefix) {
      const marker = `${prefix} runtime admitted variables: `;
      return output
        .join('')
        .split(/\r?\n/)
        .filter((line) => line.startsWith(marker))
        .map((line) => JSON.parse(line.slice(marker.length)));
    }
    function assertRuntimeKeys(output, prefix) {
      const records = runtimeKeys(output, prefix);
      assert.ok(
        records.length > 0,
        'The actual NestJS process must report admitted key names',
      );
      const allowed = new Set([...policy.configuration, ...policy.system]);
      for (const keys of records) {
        assert.deepEqual(
          keys.filter((key) => !allowed.has(key.toUpperCase())),
          [],
          'Unexpected API runtime variable names',
        );
        for (const key of [
          'DB_APP_USER',
          'DB_APP_PASSWORD',
          'DB_HOST',
          'DB_NAME',
          'OIDC_ISSUER',
          'AUTH_ENV',
          'API_PORT',
        ])
          assert.ok(keys.includes(key));
      }
    }
    async function stop(child) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* stopped */
        }
      }
      await Promise.race([exited, pause(10000)]);
      assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        'Runtime command must terminate with its child tree',
      );
    }
    async function launch(app, mode, args = []) {
      // Use the exact package commands with the complete fixture environment.
      // The launchers, not the test harness, must isolate their HTTP processes.
      assert.ok(process.env.npm_execpath, 'Run through pnpm test');
      const child = spawn(
        process.execPath,
        [
          process.env.npm_execpath,
          '--filter',
          `@innoview/${app}`,
          mode,
          ...args,
        ],
        {
          cwd: root,
          env: { ...env, UNEXPECTED_RUNTIME_SECRET: secret() },
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      children.push(child);
      child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
      child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
      const origin =
        app === 'api'
          ? env.AUTH_API_ORIGIN
          : app === 'portal'
            ? env.PORTAL_ORIGIN
            : env.CONTROL_ORIGIN;
      for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null)
          throw new Error(
            `Disposable ${app} process failed; inspect sanitized startup separately`,
          );
        try {
          if ((await fetch(origin, { signal: AbortSignal.timeout(2000) })).ok)
            return child;
        } catch {
          /* wait for binding */
        }
        await pause(250);
      }
      throw new Error(`Disposable ${app} startup timeout`);
    }
    async function login(
      browser,
      mutate,
      callbackMutate,
      username = 'runtime-test',
      captureTokens = false,
    ) {
      const initial = await browser.session();
      const start = await browser.post('/auth/login', initial.csrf);
      assert.equal(start.status, 303);
      const authUrl = new URL(start.headers.get('location'));
      assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
      const pending = await stores[
        browser.origin === env.PORTAL_ORIGIN ? 0 : 1
      ].source.query(
        `SELECT * FROM ${browser.origin === env.PORTAL_ORIGIN ? 'portal_sessions' : 'control_sessions'}.sessions WHERE kind='login'`,
      );
      if (mutate) await mutate(pending.at(-1));
      const page = await fetch(authUrl, { redirect: 'manual' });
      const html = await page.text();
      const action = html
        .match(
          /<form\b(?=[^>]*\bid="kc-form-login")[^>]*\baction="([^"]+)"/i,
        )?.[1]
        ?.replaceAll('&amp;', '&');
      assert.ok(action);
      const cookie = page.headers
        .getSetCookie()
        .map((line) => line.split(';')[0])
        .join('; ');
      const response = await fetch(action, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, origin: kc.baseUrl },
        body: new URLSearchParams({
          username,
          password: userPassword,
          credentialId: '',
        }),
      });
      assert.ok([302, 303].includes(response.status));
      for (const line of [
        ...page.headers.getSetCookie(),
        ...response.headers.getSetCookie(),
      ]) {
        const pair = line.split(';')[0];
        const at = pair.indexOf('=');
        browser.idpCookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      const callback = new URL(response.headers.get('location'));
      const original = callback.href;
      if (callbackMutate) callbackMutate(callback);
      const transaction = stores[
        browser.origin === env.PORTAL_ORIGIN ? 0 : 1
      ].unseal(pending.at(-1));
      let tokens;
      if (captureTokens) {
        // Test harness only: obtain genuine IdP tokens for negative API tests
        // without registering a local identity via the BFF. Never sent to UI.
        const tokenResponse = await fetch(
          `${kc.issuer}/protocol/openid-connect/token`,
          {
            method: 'POST',
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: authUrl.searchParams.get('client_id'),
              redirect_uri: authUrl.searchParams.get('redirect_uri'),
              code: callback.searchParams.get('code'),
              code_verifier: transaction.verifier,
            }),
          },
        );
        assert.equal(tokenResponse.status, 200);
        tokens = await tokenResponse.json();
        // Burn the outstanding app transaction through state rejection; this
        // makes no second exchange of the already consumed authorization code.
        callback.searchParams.set('state', 'invalid-test-cleanup');
      }
      const result = await browser.request(callback.href);
      return {
        result,
        callback: original,
        transaction,
        tokens,
      };
    }
    async function providerLogout(browser) {
      const current = await browser.session();
      const response = await browser.post('/auth/logout', current.csrf, {
        sso: 'true',
      });
      assert.equal(response.status, 303);
      const url = new URL(response.headers.get('location'));
      assert.equal(url.origin, kc.baseUrl);
      assert.equal(url.searchParams.get('id_token_hint'), null);
      assert.equal(
        url.searchParams.get('post_logout_redirect_uri'),
        `${browser.origin}/auth/logout/callback`,
      );
      const confirmation = await fetch(url, {
        redirect: 'manual',
        headers: {
          cookie: [...browser.idpCookies]
            .map(([k, v]) => `${k}=${v}`)
            .join('; '),
        },
      });
      assert.equal(confirmation.status, 200);
      const html = await confirmation.text();
      const action = html
        .match(/<form[^>]+action="([^"]+)"/i)?.[1]
        ?.replaceAll('&amp;', '&');
      assert.ok(action);
      const body = new URLSearchParams();
      for (const match of html.matchAll(
        /<input[^>]+name="([^"]+)"[^>]*value="([^"]*)"/g,
      ))
        body.set(match[1], match[2]);
      const done = await fetch(new URL(action, kc.baseUrl), {
        method: 'POST',
        redirect: 'manual',
        headers: {
          cookie: confirmation.headers
            .getSetCookie()
            .map((line) => line.split(';')[0])
            .join('; '),
        },
        body,
      });
      assert.ok([302, 303].includes(done.status));
      const target = new URL(done.headers.get('location'));
      assert.equal(target.origin, browser.origin);
      assert.equal(target.pathname, '/auth/logout/callback');
      assert.ok(target.searchParams.get('state'));
      return target;
    }
    async function storedSession(browser, index) {
      const store = stores[index];
      const sealed = browser.jar.get(store.config.cookie.cookieName);
      const { id } = await unsealData(sealed, {
        password: store.config.cookie.password,
        ttl: 28800,
      });
      return (
        await store.source.query(
          `SELECT * FROM ${store.table} WHERE id_hash=$1`,
          [hash(id)],
        )
      )[0];
    }
    const userPassword = secret();
    sensitive.push(userPassword);
    try {
      await bootstrap.connect();
      await bootstrap.query(`CREATE DATABASE ${pg.escapeIdentifier(database)}`);
      created = true;
      await provisionDatabase(env);
      await provisionDatabase(env);
      migrator = createDataSource('migrator', env);
      await migrator.initialize();
      await migrator.runMigrations();
      membershipObserver = createDataSource('membership', env);
      await membershipObserver.initialize();
      for (const app of ['portal', 'control'])
        stores.push(await new Store(configuration(app, env)).open());
      const realm = desiredRealm();
      // Only this ephemeral realm uses high callback ports. Development clients
      // and their approved 3000/3001 redirects are never modified.
      for (let i = 0; i < 2; i++) {
        const origin = i === 0 ? env.PORTAL_ORIGIN : env.CONTROL_ORIGIN;
        realm.clients[i].redirectUris = [`${origin}/auth/callback`];
        realm.clients[i].webOrigins = [origin];
        realm.clients[i].attributes['post.logout.redirect.uris'] =
          `${origin}/auth/logout/callback`;
      }
      assert.equal(
        (await admin('realms', { method: 'POST', body: realm })).status,
        201,
      );
      realmCreated = true;
      assert.equal(
        (
          await admin('realms/innoview/users', {
            method: 'POST',
            body: {
              username: 'runtime-test',
              firstName: 'Runtime',
              lastName: 'Test',
              email: 'runtime@example.invalid',
              emailVerified: true,
              enabled: true,
              credentials: [
                { type: 'password', value: userPassword, temporary: false },
              ],
            },
          })
        ).status,
        201,
      );
      await t.test(
        'normal pnpm API dev starts a restricted Nest child without privileged credentials',
        async () => {
          const offset = logs.length;
          const child = await launch('api', 'dev');
          try {
            assertRuntimeKeys(logs.slice(offset), 'API');
            const roles = await bootstrap.query(
              'SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND usename=$2',
              [database, env.DB_APP_USER],
            );
            assert.ok(roles.rowCount > 0);
            assert.equal(
              (await fetch(`${env.AUTH_API_ORIGIN}/auth/me`)).status,
              401,
            );
          } finally {
            await stop(child);
          }
        },
      );
      const compiledOffset = logs.length;
      await launch('api', 'start');
      const compiledRoles = await bootstrap.query(
        'SELECT usename FROM pg_stat_activity WHERE datname=$1 AND usename=$2',
        [database, env.DB_APP_USER],
      );
      await launch('portal', 'dev', ['--port', '13000']);
      await launch('control-center', 'dev', ['--port', '13001']);
      await t.test(
        'normal compiled API and both BFF launchers preserve credential separation',
        async () => {
          assertRuntimeKeys(logs.slice(compiledOffset), 'API');
          // Observe the validated startup connection before unrelated BFF builds
          // can outlast pg's legitimate idle-pool timeout.
          assert.ok(compiledRoles.rowCount > 0);
          const rights = await migrator.query(
            "SELECT has_table_privilege($1,'memberships.membership','INSERT') OR has_table_privilege($1,'memberships.membership','UPDATE') OR has_table_privilege($1,'memberships.membership','DELETE') AS writes",
            [env.DB_APP_USER],
          );
          assert.equal(rights[0].writes, false);
          const records = runtimeKeys(logs, 'BFF');
          assert.ok(records.length >= 2);
          for (const keys of records) {
            assert.ok(
              !keys.some((key) =>
                /^(DB_(BOOTSTRAP|MIGRATOR|MEMBERSHIP|ORGANIZATIONS|AUTHORIZATION|APP)_|KEYCLOAK_|IDENTITY_|PLATFORM_|TEST_)/.test(
                  key,
                ),
              ),
            );
            const prefix = keys.includes('DB_PORTAL_USER')
              ? 'PORTAL'
              : 'CONTROL';
            const other = prefix === 'PORTAL' ? 'CONTROL' : 'PORTAL';
            assert.ok(keys.includes(`DB_${prefix}_PASSWORD`));
            assert.ok(keys.includes(`${prefix}_COOKIE_PASSWORD`));
            assert.ok(keys.includes(`${prefix}_TOKEN_PASSWORD`));
            assert.ok(
              !keys.some(
                (key) =>
                  key.startsWith(`DB_${other}_`) || key.startsWith(`${other}_`),
              ),
            );
            assert.ok(
              !keys.includes('NODE_OPTIONS') && !keys.includes('NODE_PATH'),
            );
          }
        },
      );
      const portal = new Browser(env.PORTAL_ORIGIN);
      const control = new Browser(env.CONTROL_ORIGIN);
      let portalData;
      let controlData;
      let portalRow;
      let controlRow;

      await t.test(
        'HTTPS cookies are Secure and HTTP requires explicit loopback development',
        () => {
          assert.throws(() =>
            configuration('portal', { ...env, AUTH_ENV: 'production' }),
          );
          assert.throws(() =>
            configuration('portal', {
              ...env,
              PORTAL_ORIGIN: 'http://example.invalid',
            }),
          );
          const production = configuration('portal', {
            ...env,
            AUTH_ENV: 'production',
            AUTH_ALLOW_HTTP: 'false',
            PORTAL_ORIGIN: 'https://portal.example.invalid',
            AUTH_API_ORIGIN: 'https://api.example.invalid',
            OIDC_ISSUER: 'https://identity.example.invalid/realms/innoview',
            DB_SSL: 'require',
          });
          assert.equal(production.cookie.cookieOptions.secure, true);
          assert.equal(production.cookie.cookieOptions.httpOnly, true);
          assert.match(production.cookie.cookieName, /^__Host-/);
          assert.throws(() =>
            configuration('portal', {
              ...env,
              PORTAL_TOKEN_PASSWORD: env.PORTAL_COOKIE_PASSWORD,
            }),
          );
        },
      );

      await t.test(
        'CSRF, Origin and unregistered return destinations are rejected',
        async () => {
          const anon = await portal.session();
          for (const response of [
            await portal.post('/auth/login', 'wrong'),
            await portal.post(
              '/auth/login',
              anon.csrf,
              {},
              'http://attacker.invalid',
            ),
            await portal.post('/auth/login', anon.csrf, {
              returnTo: 'https://attacker.invalid',
            }),
          ])
            assert.equal(response.status, 403);
        },
      );
      await t.test(
        'HTTP correlation validates external IDs and associates authentication rejection without sensitive metadata',
        async () => {
          const id = randomUUID();
          const response = await fetch(`${env.AUTH_API_ORIGIN}/auth/me`, {
            headers: { 'x-correlation-id': id },
          });
          assert.equal(response.status, 401);
          assert.equal(response.headers.get('x-correlation-id'), id);
          const replacement = await fetch(`${env.AUTH_API_ORIGIN}/auth/me`, {
            headers: { 'x-correlation-id': 'untrusted-input' },
          });
          assert.equal(replacement.status, 401);
          assert.match(
            replacement.headers.get('x-correlation-id'),
            /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
          );
        },
      );
      await t.test(
        'both real frontends login via Code+PKCE; cookies and identities are separate',
        async () => {
          for (const browser of [portal, control]) {
            const { result, callback, transaction } = await login(browser);
            assert.equal(result.status, 303);
            assert.equal(result.headers.get('location'), `${browser.origin}/`);
            const replay = await browser.request(callback);
            assert.equal(replay.status, 400);
            const codeReplay = await fetch(
              `${kc.issuer}/protocol/openid-connect/token`,
              {
                method: 'POST',
                body: new URLSearchParams({
                  grant_type: 'authorization_code',
                  client_id:
                    browser === portal
                      ? 'innoview-portal'
                      : 'innoview-control-center',
                  redirect_uri: `${browser.origin}/auth/callback`,
                  code: new URL(callback).searchParams.get('code'),
                  code_verifier: transaction.verifier,
                }),
              },
            );
            assert.equal(codeReplay.status, 400);
            assert.equal((await codeReplay.json()).error, 'invalid_grant');
            // Keycloak can revoke the client session on code replay. Establish a
            // fresh legitimate session before testing independent refresh paths.
            assert.equal((await login(browser)).result.status, 303);
            const session = await browser.session();
            assert.equal(session.authenticated, true);
            assert.equal(
              session.identity.clientId,
              browser === portal
                ? 'innoview-portal'
                : 'innoview-control-center',
            );
          }
          portalRow = await storedSession(portal, 0);
          controlRow = await storedSession(control, 1);
          portalData = stores[0].unseal(portalRow);
          controlData = stores[1].unseal(controlRow);
          sensitive.push(
            portalData.access,
            portalData.refresh,
            portalData.idToken,
            controlData.access,
            controlData.refresh,
            controlData.idToken,
          );
          assert.notEqual(
            [...portal.jar.keys()][0],
            [...control.jar.keys()][0],
          );
          const swapped = new Browser(env.CONTROL_ORIGIN);
          swapped.jar = new Map(portal.jar);
          assert.equal((await swapped.session()).authenticated, false);
          const renamed = new Browser(env.CONTROL_ORIGIN);
          renamed.jar.set(
            stores[1].config.cookie.cookieName,
            portal.jar.get(stores[0].config.cookie.cookieName),
          );
          assert.equal((await renamed.session()).authenticated, false);
          await assert.rejects(
            stores[0].source.query('SELECT * FROM control_sessions.sessions'),
          );
          await assert.rejects(
            stores[1].source.query(
              'CREATE TABLE control_sessions.forbidden(id int)',
            ),
          );
          assert.ok(!portalRow.encrypted.includes(portalData.access));
        },
      );
      await t.test(
        'local identity is created at login and shared by repeated Portal/Control Center authentication without affiliations',
        async () => {
          const portalIdentity = (await portal.session()).identity;
          const controlIdentity = (await control.session()).identity;
          assert.match(portalIdentity.id, /^[0-9a-f-]{36}$/);
          assert.equal(portalIdentity.id, controlIdentity.id);
          const rows = await migrator.query(
            'SELECT * FROM identity.user_identity',
          );
          assert.equal(rows.length, 1);
          const first = rows[0];
          for (const method of ['GET', 'PUT']) {
            const response = await fetch(`${env.AUTH_API_ORIGIN}/identity/me`, {
              method,
              headers: { authorization: `Bearer ${portalData.access}` },
            });
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.id, first.id);
            assert.deepEqual(Object.keys(body).sort(), [
              'createdAt',
              'externalSubject',
              'id',
              'issuer',
              'updatedAt',
            ]);
          }
          const spoof = await fetch(`${env.AUTH_API_ORIGIN}/identity/me`, {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${portalData.access}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              issuer: 'https://untrusted.invalid',
              sub: 'forged',
              tenant_id: 'forged',
              role: 'admin',
            }),
          });
          assert.equal(spoof.status, 400);
          for (const method of ['GET', 'PUT'])
            assert.equal(
              (await fetch(`${env.AUTH_API_ORIGIN}/identity/me`, { method }))
                .status,
              401,
            );
          assert.equal(
            (
              await fetch(`${env.AUTH_API_ORIGIN}/identity/me`, {
                method: 'PUT',
                headers: { authorization: `Bearer ${portalData.idToken}` },
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await migrator.query(
                'SELECT count(*)::int AS count FROM organizations.tenant',
              )
            )[0].count,
            0,
          );
          const after = (
            await migrator.query('SELECT * FROM identity.user_identity')
          )[0];
          assert.deepEqual(after, first);
          const tables = await migrator.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'",
          );
          assert.deepEqual(tables.map((row) => row.table_name).sort(), [
            'audit_event',
            'audit_event',
            'audit_event',
            'branch',
            'business_group',
            'catalog_version',
            'company',
            'directory_repair_event',
            'directory_repair_operation',
            'membership',
            'migrations',
            'operation',
            'operation',
            'organizational_unit',
            'permission',
            'persistence_probe',
            'role',
            'role_assignment',
            'role_permission',
            'sessions',
            'sessions',
            'tenant',
            'tenant_directory',
            'tenant_revision',
            'typeorm_metadata',
            'user_identity',
          ]);
        },
      );
      await t.test(
        'login never creates memberships or implies tenant access',
        async () => {
          assert.equal(
            (
              await membershipObserver.query(
                'SELECT count(*)::int AS count FROM memberships.membership',
              )
            )[0].count,
            0,
          );
          for (const method of ['POST', 'DELETE']) {
            const response = await fetch(`${env.AUTH_API_ORIGIN}/memberships`, {
              method,
              headers: { authorization: `Bearer ${portalData.access}` },
            });
            assert.equal(response.status, 404);
          }
        },
      );
      await t.test(
        'authenticated callers cannot expose Organizations through guessed UUID routes',
        async () => {
          const { OrganizationsService } =
            await import('../../apps/api/dist/organizations/organizations.service.js');
          const source = await initializeOrganizationsOperatorDataSource(env);
          const provisioner =
            await initializeOrganizationsProvisionerDataSource(env);
          try {
            const service = new OrganizationsService(source, provisioner);
            for (const label of ['Route fixture A', 'Route fixture B']) {
              const structure = await service.createTenant(
                label,
                `${label} group`,
                organizationOperation(),
              );
              for (const path of [
                '/memberships',
                `/memberships/${structure.tenant.id}`,
                '/organizations',
                '/organizations/tenants',
                `/organizations/tenants/${structure.tenant.id}`,
                `/tenants/${structure.tenant.id}`,
              ]) {
                for (const token of [undefined, portalData.access]) {
                  const response = await fetch(
                    `${env.AUTH_API_ORIGIN}${path}`,
                    {
                      headers: token
                        ? { authorization: `Bearer ${token}` }
                        : {},
                    },
                  );
                  assert.equal(response.status, 404);
                  assert.ok(!(await response.text()).includes(label));
                }
              }
            }
          } finally {
            await provisioner.destroy();
            await source.destroy();
          }
        },
      );
      await t.test(
        'first concurrent registration for a second authenticated subject returns exactly one new stable UUID',
        async () => {
          await admin('realms/innoview/users', {
            method: 'POST',
            body: {
              username: 'runtime-second',
              firstName: 'Second',
              lastName: 'Test',
              email: 'second@example.invalid',
              emailVerified: true,
              enabled: true,
              credentials: [
                { type: 'password', value: userPassword, temporary: false },
              ],
            },
          });
          const second = new Browser(env.PORTAL_ORIGIN);
          const { tokens } = await login(
            second,
            undefined,
            undefined,
            'runtime-second',
            true,
          );
          sensitive.push(
            tokens.access_token,
            tokens.refresh_token,
            tokens.id_token,
          );
          const headers = { authorization: `Bearer ${tokens.access_token}` };
          assert.equal(
            (await fetch(`${env.AUTH_API_ORIGIN}/identity/me`, { headers }))
              .status,
            404,
          );
          const responses = await Promise.all(
            Array.from({ length: 16 }, () =>
              fetch(`${env.AUTH_API_ORIGIN}/identity/me`, {
                method: 'PUT',
                headers,
              }),
            ),
          );
          assert.ok(responses.every((response) => response.status === 200));
          const identities = await Promise.all(
            responses.map((response) => response.json()),
          );
          assert.equal(
            new Set(identities.map((identity) => identity.id)).size,
            1,
          );
          assert.notEqual(
            identities[0].id,
            (await portal.session()).identity.id,
          );
          assert.equal(
            (
              await migrator.query(
                'SELECT count(*)::int AS count FROM identity.user_identity',
              )
            )[0].count,
            2,
          );
          const again = await fetch(`${env.AUTH_API_ORIGIN}/identity/me`, {
            method: 'PUT',
            headers,
          });
          assert.deepEqual(await again.json(), identities[0]);
        },
      );
      await t.test(
        'an authenticated legacy 1.2 session acquires its UUID without discarding the session',
        async () => {
          await admin('realms/innoview/users', {
            method: 'POST',
            body: {
              username: 'runtime-legacy',
              firstName: 'Legacy',
              lastName: 'Test',
              email: 'legacy@example.invalid',
              emailVerified: true,
              enabled: true,
              credentials: [
                { type: 'password', value: userPassword, temporary: false },
              ],
            },
          });
          const legacy = new Browser(env.PORTAL_ORIGIN);
          const { tokens } = await login(
            legacy,
            undefined,
            undefined,
            'runtime-legacy',
            true,
          );
          sensitive.push(
            tokens.access_token,
            tokens.refresh_token,
            tokens.id_token,
          );
          const subject = decodeJwt(tokens.access_token).sub;
          assert.equal(
            (
              await fetch(`${env.AUTH_API_ORIGIN}/identity/me`, {
                headers: { authorization: `Bearer ${tokens.access_token}` },
              })
            ).status,
            404,
          );
          const id = await stores[0].create(
            'session',
            {
              csrf: secret(),
              issuer: kc.issuer,
              subject,
              access: tokens.access_token,
              refresh: tokens.refresh_token,
              idToken: tokens.id_token,
            },
            28800,
            300,
          );
          const sealed = await sealData(
            { id },
            { password: env.PORTAL_COOKIE_PASSWORD, ttl: 28800 },
          );
          legacy.jar.set(stores[0].config.cookie.cookieName, sealed);
          const upgraded = await legacy.session();
          assert.equal(upgraded.authenticated, true);
          assert.match(upgraded.identity.id, /^[0-9a-f-]{36}$/);
          assert.equal(
            legacy.jar.get(stores[0].config.cookie.cookieName),
            sealed,
          );
          assert.equal(
            (await legacy.session()).identity.id,
            upgraded.identity.id,
          );
        },
      );
      await verifyContext(t, {
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
        portal,
        control,
      });
      await t.test(
        'state and nonce tampering consume the transaction and cannot establish a session',
        async () => {
          const wrongState = new Browser(env.PORTAL_ORIGIN);
          const attempt = await login(wrongState, undefined, (url) =>
            url.searchParams.set('state', 'wrong'),
          );
          assert.equal(attempt.result.status, 400);
          assert.equal(
            (await wrongState.request(attempt.callback)).status,
            400,
          );
          assert.equal((await wrongState.session()).authenticated, false);
          const wrongNonce = new Browser(env.CONTROL_ORIGIN);
          const nonceAttempt = await login(wrongNonce, async (row) => {
            const data = stores[1].unseal(row);
            data.nonce = secret();
            await stores[1].source.query(
              'UPDATE control_sessions.sessions SET encrypted=$2 WHERE id_hash=$1',
              [row.id_hash, stores[1].seal(data, row.id_hash)],
            );
          });
          assert.equal(nonceAttempt.result.status, 400);
          assert.equal((await wrongNonce.session()).authenticated, false);
          const wrongIssuer = new Browser(env.PORTAL_ORIGIN);
          const issuerAttempt = await login(wrongIssuer, undefined, (url) =>
            url.searchParams.set('iss', 'https://untrusted.invalid'),
          );
          assert.equal(issuerAttempt.result.status, 400);
          assert.equal((await wrongIssuer.session()).authenticated, false);
        },
      );
      await t.test(
        'Nest /auth/me accepts only API access tokens and returns a minimal principal',
        async () => {
          const good = await fetch(`${env.AUTH_API_ORIGIN}/auth/me`, {
            headers: { authorization: `Bearer ${portalData.access}` },
          });
          assert.equal(good.status, 200);
          assert.deepEqual(Object.keys(await good.json()).sort(), [
            'clientId',
            'issuer',
            'subject',
          ]);
          const jwks = await (
            await fetch(`${kc.issuer}/protocol/openid-connect/certs`)
          ).json();
          const { privateKey } = await generateKeyPair('RS256');
          async function forged(overrides = {}) {
            return new SignJWT({
              ...decodeJwt(portalData.access),
              ...overrides,
            })
              .setProtectedHeader({
                alg: 'RS256',
                kid: jwks.keys.find((k) => k.use === 'sig').kid,
              })
              .sign(privateKey);
          }
          for (const token of [
            undefined,
            portalData.idToken,
            await forged(),
            await forged({ exp: 1 }),
            await forged({ aud: 'other-api' }),
          ]) {
            const response = await fetch(`${env.AUTH_API_ORIGIN}/auth/me`, {
              headers: token ? { authorization: `Bearer ${token}` } : {},
            });
            assert.equal(response.status, 401);
            const text = await response.text();
            assert.ok(!token || !text.includes(token));
          }
        },
      );
      await t.test(
        'Nest rejects genuinely signed Keycloak tokens with an invalid audience or expired lifetime',
        async () => {
          const scopes = (await admin('realms/innoview/client-scopes')).data;
          const scope = scopes.find(
            (item) => item.name === 'innoview-api-access',
          );
          const mappers = (
            await admin(
              `realms/innoview/client-scopes/${scope.id}/protocol-mappers/models`,
            )
          ).data;
          const mapper = mappers.find(
            (item) => item.name === 'innoview-api-audience',
          );
          const mapperPath = `realms/innoview/client-scopes/${scope.id}/protocol-mappers/models/${mapper.id}`;
          try {
            await admin(mapperPath, {
              method: 'PUT',
              body: {
                ...mapper,
                config: {
                  ...mapper.config,
                  'included.client.audience': 'unrelated-api',
                },
              },
            });
            const wrongAudience = new Browser(env.PORTAL_ORIGIN);
            const { tokens } = await login(
              wrongAudience,
              undefined,
              undefined,
              'runtime-test',
              true,
            );
            const payload = {
              access: tokens.access_token,
              refresh: tokens.refresh_token,
              idToken: tokens.id_token,
            };
            sensitive.push(payload.access, payload.refresh, payload.idToken);
            assert.ok(
              ![decodeJwt(payload.access).aud].flat().includes('innoview-api'),
            );
            assert.equal(
              (
                await fetch(`${env.AUTH_API_ORIGIN}/auth/me`, {
                  headers: { authorization: `Bearer ${payload.access}` },
                })
              ).status,
              401,
            );
          } finally {
            await admin(mapperPath, { method: 'PUT', body: mapper });
          }
          const realmSettings = (await admin('realms/innoview')).data;
          try {
            await admin('realms/innoview', {
              method: 'PUT',
              body: { ...realmSettings, accessTokenLifespan: 1 },
            });
            const expired = new Browser(env.PORTAL_ORIGIN);
            const { tokens } = await login(
              expired,
              undefined,
              undefined,
              'runtime-test',
              true,
            );
            const payload = {
              access: tokens.access_token,
              refresh: tokens.refresh_token,
              idToken: tokens.id_token,
            };
            sensitive.push(payload.access, payload.refresh, payload.idToken);
            const claims = decodeJwt(payload.access);
            assert.equal(claims.exp - claims.iat, 1);
            const wait = Math.max(0, (claims.exp + 6) * 1000 - Date.now());
            await pause(wait);
            assert.equal(
              (
                await fetch(`${env.AUTH_API_ORIGIN}/auth/me`, {
                  headers: { authorization: `Bearer ${payload.access}` },
                })
              ).status,
              401,
            );
          } finally {
            await admin('realms/innoview', {
              method: 'PUT',
              body: realmSettings,
            });
          }
        },
      );
      await t.test(
        'concurrent refresh requests across HTTP handlers rotate once without token reuse',
        async () => {
          await stores[0].source.query(
            'UPDATE portal_sessions.sessions SET access_until=now() WHERE id_hash=$1',
            [portalRow.id_hash],
          );
          const replies = await Promise.all(
            Array.from({ length: 8 }, () => portal.session()),
          );
          assert.ok(replies.every((value) => value.authenticated));
          const after = (
            await stores[0].source.query(
              'SELECT * FROM portal_sessions.sessions WHERE id_hash=$1',
              [portalRow.id_hash],
            )
          )[0];
          assert.equal(after.version, 1);
          assert.equal(after.lease_id, null);
          const refreshed = stores[0].unseal(after);
          sensitive.push(
            refreshed.access,
            refreshed.refresh,
            refreshed.idToken,
          );
          assert.notEqual(refreshed.refresh, portalData.refresh);
          const activity = await bootstrap.query(
            'SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND state=$2',
            [database, 'idle in transaction'],
          );
          assert.equal(activity.rowCount, 0);
        },
      );
      await t.test(
        'expired, revoked and uncertain-refresh sessions fail closed',
        async () => {
          await stores[0].source.query(
            "UPDATE portal_sessions.sessions SET expires_at=now()-interval '1 second' WHERE id_hash=$1",
            [portalRow.id_hash],
          );
          assert.equal((await portal.session()).authenticated, false);
          await stores[1].source.query(
            'DELETE FROM control_sessions.sessions WHERE id_hash=$1',
            [controlRow.id_hash],
          );
          assert.equal((await control.session()).authenticated, false);
          await login(portal);
          await stores[0].source.query(
            "UPDATE portal_sessions.sessions SET lease_id=$1,lease_until=now()-interval '1 second' WHERE kind='session'",
            [randomUUID()],
          );
          assert.equal((await portal.session()).authenticated, false);
        },
      );
      await t.test(
        'local logout revokes the old cookie and server validates real SSO returns for both frontends',
        async () => {
          await login(portal);
          const session = await portal.session();
          const old = new Map(portal.jar);
          assert.equal(
            (await portal.post('/auth/logout', session.csrf)).status,
            303,
          );
          portal.jar = old;
          assert.equal((await portal.session()).authenticated, false);
          for (const browser of [portal, control]) {
            await login(browser);
            assert.equal(
              (await browser.request('/auth/logout/callback?state=forged'))
                .status,
              400,
            );
            assert.equal((await browser.session()).authenticated, true);
            const target = await providerLogout(browser);
            const pending = new Map(browser.jar);
            const finish = await browser.request(target.href); // exact real IdP Location, no JS relay
            assert.equal(finish.status, 303);
            assert.equal(finish.headers.get('location'), `${browser.origin}/`);
            browser.jar = pending;
            assert.equal((await browser.request(target.href)).status, 400);
            assert.equal((await browser.session()).authenticated, false);
          }
        },
      );
      await t.test(
        'SSO return rejects missing, incorrect and duplicate state; failed transactions cannot be replayed',
        async () => {
          for (const mode of ['missing', 'incorrect', 'duplicate', 'unicode']) {
            const browser = new Browser(
              mode === 'incorrect' ? env.PORTAL_ORIGIN : env.CONTROL_ORIGIN,
            );
            assert.equal((await login(browser)).result.status, 303);
            const target = await providerLogout(browser);
            const original = new URL(target);
            const pending = new Map(browser.jar);
            if (mode === 'missing') target.searchParams.delete('state');
            else if (mode === 'incorrect')
              target.searchParams.set('state', 'wrong');
            else if (mode === 'unicode')
              target.searchParams.set(
                'state',
                '\u00e9'.repeat(target.searchParams.get('state').length),
              );
            else target.searchParams.append('state', 'duplicate');
            assert.equal((await browser.request(target.href)).status, 400);
            browser.jar = pending;
            assert.equal((await browser.request(original.href)).status, 400);
            assert.equal((await browser.session()).authenticated, false);
          }
        },
      );
      // Terminal destructive catalog partition: only secret-leak assertions and
      // disposal follow. No other test observes the deprecated global probe.
      await verifyAccessHttp(t, { env, login, Browser, migrator, sensitive });
      await t.test(
        'no passwords or tokens in application logs or BFF browser responses',
        () => {
          const output =
            logs.join('\n') +
            portal.responses.join('\n') +
            control.responses.join('\n');
          for (const value of [
            ...sensitive,
            ...Object.entries(env)
              .filter(([key]) => key.endsWith('PASSWORD'))
              .map(([, value]) => value),
          ])
            assert.ok(
              !output.includes(value),
              'Sensitive material must remain server-side',
            );
          assert.ok(!/"(?:access_token|refresh_token|id_token)"/.test(output));
        },
      );
    } finally {
      for (const child of children) {
        await stop(child);
      }
      for (const store of stores)
        if (store.source.isInitialized) await store.source.destroy();
      if (membershipObserver?.isInitialized) await membershipObserver.destroy();
      if (migrator?.isInitialized) await migrator.destroy();
      if (realmCreated) await admin('realms/innoview', { method: 'DELETE' });
      if (created) {
        await bootstrap.query(
          `DROP DATABASE ${pg.escapeIdentifier(database)} WITH (FORCE)`,
        );
        for (const key of [
          'DB_APP_USER',
          'DB_MIGRATOR_USER',
          'DB_PORTAL_USER',
          'DB_CONTROL_USER',
          'DB_MEMBERSHIP_USER',
          'DB_ORGANIZATIONS_USER',
          'DB_AUTHORIZATION_USER',
          'DB_ORGANIZATIONS_PROVISIONER_USER',
          'DB_DIRECTORY_MAINTENANCE_USER',
        ])
          await bootstrap.query(`DROP ROLE ${pg.escapeIdentifier(env[key])}`);
      }
      await bootstrap.end();
    }
  },
);
