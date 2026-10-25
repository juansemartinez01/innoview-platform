import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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
const { unsealData } = requireBff('iron-session');
const { provisionDatabase } =
  await import('../../apps/api/dist/persistence/provision.js');
const { createDataSource } =
  await import('../../apps/api/dist/persistence/data-sources.js');
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
    async function launch(app, args) {
      // Runtime processes receive only their required credentials, never bootstrap,
      // migrator or Keycloak administrator secrets, nor the other BFF's keys.
      const runtime = { ...env };
      for (const key of Object.keys(runtime))
        if (/PASSWORD|_USER$/.test(key)) delete runtime[key];
      const prefix =
        app === 'api'
          ? 'DB_APP'
          : app === 'portal'
            ? 'DB_PORTAL'
            : 'DB_CONTROL';
      runtime[`${prefix}_USER`] = env[`${prefix}_USER`];
      runtime[`${prefix}_PASSWORD`] = env[`${prefix}_PASSWORD`];
      if (app !== 'api') {
        const group = app === 'portal' ? 'PORTAL' : 'CONTROL';
        runtime[`${group}_COOKIE_PASSWORD`] = env[`${group}_COOKIE_PASSWORD`];
        runtime[`${group}_TOKEN_PASSWORD`] = env[`${group}_TOKEN_PASSWORD`];
      }
      const child = spawn(process.execPath, args, {
        cwd: `${root}/apps/${app}`,
        env: runtime,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
            return;
        } catch {
          /* wait for binding */
        }
        await pause(250);
      }
      throw new Error(`Disposable ${app} startup timeout`);
    }
    async function login(browser, mutate, callbackMutate) {
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
          username: 'runtime-test',
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
      const result = await browser.request(callback.href);
      return {
        result,
        callback: original,
        transaction: stores[
          browser.origin === env.PORTAL_ORIGIN ? 0 : 1
        ].unseal(pending.at(-1)),
      };
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
      for (const app of ['portal', 'control'])
        stores.push(await new Store(configuration(app, env)).open());
      const realm = desiredRealm();
      // Only this ephemeral realm uses high callback ports. Development clients
      // and their approved 3000/3001 redirects are never modified.
      for (let i = 0; i < 2; i++) {
        const origin = i === 0 ? env.PORTAL_ORIGIN : env.CONTROL_ORIGIN;
        realm.clients[i].redirectUris = [`${origin}/auth/callback`];
        realm.clients[i].webOrigins = [origin];
        realm.clients[i].attributes['post.logout.redirect.uris'] = `${origin}/`;
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
      await launch('api', ['dist/main.js']);
      await launch('portal', [
        'node_modules/next/dist/bin/next',
        'dev',
        '--hostname',
        '127.0.0.1',
        '--port',
        '13000',
      ]);
      await launch('control-center', [
        'node_modules/next/dist/bin/next',
        'dev',
        '--hostname',
        '127.0.0.1',
        '--port',
        '13001',
      ]);
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
          portalRow = (
            await stores[0].source.query(
              `SELECT * FROM portal_sessions.sessions WHERE kind='session'`,
            )
          )[0];
          controlRow = (
            await stores[1].source.query(
              `SELECT * FROM control_sessions.sessions WHERE kind='session'`,
            )
          )[0];
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
            assert.equal((await login(wrongAudience)).result.status, 303);
            const payload = stores[0].unseal(
              await storedSession(wrongAudience, 0),
            );
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
            assert.equal((await login(expired)).result.status, 303);
            const payload = stores[0].unseal(await storedSession(expired, 0));
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
        'local logout revokes the old cookie; SSO logout goes only to the configured IdP',
        async () => {
          await login(portal);
          const session = await portal.session();
          const old = new Map(portal.jar);
          const logout = await portal.post('/auth/logout', session.csrf);
          assert.equal(logout.status, 303);
          portal.jar = old;
          assert.equal((await portal.session()).authenticated, false);
          await login(control);
          const controlSession = await control.session();
          const sso = await control.post('/auth/logout', controlSession.csrf, {
            sso: 'true',
          });
          assert.equal(sso.status, 303);
          const url = new URL(sso.headers.get('location'));
          assert.equal(url.origin, kc.baseUrl);
          assert.equal(url.searchParams.get('id_token_hint'), null);
          const confirmation = await fetch(url, {
            redirect: 'manual',
            headers: {
              cookie: [...control.idpCookies]
                .map(([k, v]) => `${k}=${v}`)
                .join('; '),
            },
          });
          assert.equal(confirmation.status, 200);
          // Keycloak's confirmation form is the real provider logout, not a fake
          // application route. Submit only its own CSRF-protected form.
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
          assert.equal(target.origin, env.CONTROL_ORIGIN);
          const finish = await control.request(
            `/auth/logout/callback?state=${encodeURIComponent(target.searchParams.get('state'))}`,
          );
          assert.equal(finish.status, 303);
          assert.equal((await control.session()).authenticated, false);
        },
      );
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
        child.kill();
        await Promise.race([once(child, 'exit').catch(() => {}), pause(5000)]);
      }
      for (const store of stores)
        if (store.source.isInitialized) await store.source.destroy();
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
        ])
          await bootstrap.query(`DROP ROLE ${pg.escapeIdentifier(env[key])}`);
      }
      await bootstrap.end();
    }
  },
);
