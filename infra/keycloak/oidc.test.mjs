import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as oidc from 'openid-client';
import {
  decodeJwt,
  decodeProtectedHeader,
  generateKeyPair,
  SignJWT,
} from 'jose';
import { configuration, REALM, CLIENT_IDS, API_AUDIENCE } from './contract.mjs';
import { administrator, inspectRealm, provisionRealm } from './admin.mjs';
import {
  apiVerifier,
  verifyAccessToken,
  verifyPublicEndpoints,
} from './verify.mjs';

// Only the disposable server with its distinct test administrator is accepted.
const config = configuration(process.env, true);
const request = await administrator(config);
if ((await request(`realms/${REALM}`)).status !== 404) {
  throw new Error(
    'OIDC tests require an empty disposable Keycloak; existing innoview realm preserved. Restart only keycloak-test.',
  );
}

async function authorization(client, clientId, username, password) {
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const index = CLIENT_IDS.indexOf(clientId);
  const url = oidc.buildAuthorizationUrl(client, {
    redirect_uri: `http://127.0.0.1:${3000 + index}/auth/callback`,
    scope: 'openid',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  const jar = new Map();
  function cookies(response) {
    for (const item of response.headers.getSetCookie()) {
      const pair = item.split(';')[0];
      const separator = pair.indexOf('=');
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
  const page = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  cookies(page);
  assert.equal(page.status, 200);
  const html = await page.text();
  const action = html
    .match(/<form\b(?=[^>]*\bid="kc-form-login")[^>]*\baction="([^"]+)"/i)?.[1]
    ?.replaceAll('&amp;', '&');
  assert.ok(
    action,
    'Expected the pinned Keycloak login form (test only, no application UI)',
  );
  assert.equal(new URL(action).origin, config.baseUrl);
  const response = await fetch(action, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
    headers: {
      cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
      origin: config.baseUrl,
    },
    body: new URLSearchParams({ username, password, credentialId: '' }),
  });
  assert.ok(
    [302, 303].includes(response.status),
    'Ephemeral authentication should redirect with a code',
  );
  const callback = new URL(response.headers.get('location'));
  assert.equal(callback.origin, `http://127.0.0.1:${3000 + index}`);
  assert.equal(callback.searchParams.get('state'), state);
  await assert.rejects(
    oidc.authorizationCodeGrant(client, callback, {
      pkceCodeVerifier: verifier,
      expectedState: oidc.randomState(),
      expectedNonce: nonce,
      idTokenExpected: true,
    }),
  );
  return oidc.authorizationCodeGrant(client, callback, {
    pkceCodeVerifier: verifier,
    expectedState: state,
    expectedNonce: nonce,
    idTokenExpected: true,
  });
}

await test('real disposable Keycloak: reproducible OIDC contract, tokens and safe drift rejection', async (t) => {
  const username = `contract-${randomUUID()}`;
  const password = randomBytes(24).toString('hex');
  let portalTokens;
  let controlTokens;
  let verify;

  await t.test(
    'create from initialized master, repeat read-only and preserve master',
    async () => {
      const before = (await request('realms/master')).data.id;
      await provisionRealm(request);
      let writes = 0;
      await provisionRealm((path, options = {}) => {
        if (options.method && options.method !== 'GET') writes++;
        return request(path, options);
      });
      assert.equal(writes, 0);
      assert.equal((await request('realms/master')).data.id, before);
      assert.deepEqual((await inspectRealm(request)).differences, []);
    },
  );

  await t.test(
    'discovery, canonical issuer, usable public JWKS and openid-client compatibility',
    async () => {
      const result = await verifyPublicEndpoints(config);
      assert.ok(result.signingKeys >= 1);
      const alternate = await fetch(
        `${config.issuer}/.well-known/openid-configuration`,
        { headers: { host: 'keycloak-test:8080' } },
      );
      assert.equal((await alternate.json()).issuer, config.issuer);
      verify = apiVerifier(config);
    },
  );

  await t.test(
    'PKCE is mandatory and unregistered redirects and legacy grants are rejected',
    async () => {
      const result = await verifyPublicEndpoints(config);
      for (const redirect of [
        'http://127.0.0.1:3000/auth/callback',
        'http://attacker.invalid/callback',
      ]) {
        const url = oidc.buildAuthorizationUrl(result.client, {
          scope: 'openid',
          redirect_uri: redirect,
          state: oidc.randomState(),
        });
        const response = await fetch(url, { redirect: 'manual' });
        if (redirect === 'http://127.0.0.1:3000/auth/callback') {
          assert.equal(response.status, 302);
          const errorUrl = new URL(response.headers.get('location'));
          assert.equal(errorUrl.origin, 'http://127.0.0.1:3000');
          assert.equal(errorUrl.searchParams.get('error'), 'invalid_request');
          assert.equal(errorUrl.searchParams.get('code'), null);
        } else assert.equal(response.status, 400);
      }
      for (const grant of ['password', 'client_credentials']) {
        const response = await fetch(result.metadata.token_endpoint, {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: grant,
            client_id: CLIENT_IDS[0],
            username,
            password,
          }),
          redirect: 'manual',
        });
        assert.ok(response.status >= 400 && response.status < 500);
      }
    },
  );

  await t.test(
    'Code + PKCE for both clients issues API-only access tokens; ID tokens are not API tokens',
    async () => {
      const created = await request(`realms/${REALM}/users`, {
        method: 'POST',
        body: {
          username,
          enabled: true,
          firstName: 'Contract',
          lastName: 'Test',
          email: `${randomUUID()}@example.invalid`,
          emailVerified: true,
          requiredActions: [],
          credentials: [
            { type: 'password', value: password, temporary: false },
          ],
        },
      });
      assert.equal(created.status, 201);
      for (const clientId of CLIENT_IDS) {
        const client = await oidc.discovery(
          new URL(config.issuer),
          clientId,
          { id_token_signed_response_alg: 'RS256' },
          oidc.None(),
          { execute: [oidc.allowInsecureRequests] },
        );
        oidc.enableNonRepudiationChecks(client);
        const tokens = await authorization(
          client,
          clientId,
          username,
          password,
        );
        const identity = await verify(tokens.access_token);
        assert.equal(identity.issuer, config.issuer);
        assert.equal(identity.clientId, clientId);
        assert.ok(identity.subject);
        assert.equal(decodeProtectedHeader(tokens.access_token).alg, 'RS256');
        const payload = decodeJwt(tokens.access_token);
        assert.ok([payload.aud].flat().includes(API_AUDIENCE));
        assert.equal(payload.realm_access, undefined);
        assert.equal(payload.resource_access, undefined);
        await assert.rejects(verify(tokens.id_token));
        if (clientId === CLIENT_IDS[0]) portalTokens = tokens;
        else controlTokens = tokens;
      }
    },
  );

  await t.test(
    'forged access tokens are rejected; refresh rotation and RP logout enforce the contract',
    async () => {
      assert.ok(portalTokens?.refresh_token);
      const result = await verifyPublicEndpoints(config);
      const refreshed = await oidc.refreshTokenGrant(
        result.client,
        portalTokens.refresh_token,
      );
      await verify(refreshed.access_token);
      assert.notEqual(refreshed.refresh_token, portalTokens.refresh_token);
      await assert.rejects(
        oidc.refreshTokenGrant(result.client, portalTokens.refresh_token),
      );
      const { privateKey } = await generateKeyPair('RS256');
      const forged = await new SignJWT({
        sub: 'test',
        azp: CLIENT_IDS[0],
        typ: 'Bearer',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'untrusted-test-key' })
        .setIssuer(config.issuer)
        .setAudience(API_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      await assert.rejects(verify(forged));
      assert.ok(result.metadata.end_session_endpoint);
      const controlClient = await oidc.discovery(
        new URL(config.issuer),
        CLIENT_IDS[1],
        { id_token_signed_response_alg: 'RS256' },
        oidc.None(),
        { execute: [oidc.allowInsecureRequests] },
      );
      const state = oidc.randomState();
      const logoutUrl = oidc.buildEndSessionUrl(controlClient, {
        id_token_hint: controlTokens.id_token,
        post_logout_redirect_uri: 'http://127.0.0.1:3001/',
        state,
      });
      const logout = await fetch(logoutUrl, { redirect: 'manual' });
      assert.equal(logout.status, 302);
      const landing = new URL(logout.headers.get('location'));
      assert.equal(landing.origin, 'http://127.0.0.1:3001');
      assert.equal(landing.pathname, '/');
      assert.equal(landing.searchParams.get('state'), state);
      logoutUrl.searchParams.set(
        'post_logout_redirect_uri',
        'http://attacker.invalid/',
      );
      const badLogout = await fetch(logoutUrl, { redirect: 'manual' });
      assert.equal(badLogout.status, 400);
    },
  );

  await t.test(
    'drift is detected without modifying the existing client or unrelated clients',
    async () => {
      const list = (
        await request(`realms/${REALM}/clients?clientId=${CLIENT_IDS[0]}`)
      ).data;
      const path = `realms/${REALM}/clients/${list[0].id}`;
      const actual = (await request(path)).data;
      await request(path, {
        method: 'PUT',
        body: {
          ...actual,
          redirectUris: ['http://127.0.0.1:3000/intentional-test-drift'],
        },
      });
      let writes = 0;
      await assert.rejects(
        provisionRealm((path, options = {}) => {
          if (options.method && options.method !== 'GET') writes++;
          return request(path, options);
        }),
        /drift/,
      );
      assert.equal(writes, 0);
      assert.deepEqual((await request(path)).data.redirectUris, [
        'http://127.0.0.1:3000/intentional-test-drift',
      ]);
    },
  );

  await t.test(
    'unmanaged innoview realm is refused and preserved (disposable server only)',
    async () => {
      await request(`realms/${REALM}`, { method: 'DELETE' });
      await request('realms', {
        method: 'POST',
        body: {
          realm: REALM,
          enabled: true,
          displayName: 'Unmanaged test realm',
        },
      });
      await assert.rejects(provisionRealm(request), /not managed/);
      assert.equal(
        (await request(`realms/${REALM}`)).data.displayName,
        'Unmanaged test realm',
      );
      // Only this test-created realm on the disposable server is removed.
      await request(`realms/${REALM}`, { method: 'DELETE' });
    },
  );
});

await test('JWT acceptance contract with synthetic keys: reject wrong issuer/audience/algorithm/expiry/type', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const now = Math.floor(Date.now() / 1000);
  async function fixture(overrides = {}, algorithm = 'RS256') {
    return new SignJWT({
      sub: 'synthetic-subject',
      typ: 'Bearer',
      azp: CLIENT_IDS[0],
      iss: config.issuer,
      aud: API_AUDIENCE,
      iat: now,
      exp: now + 300,
      ...overrides,
    })
      .setProtectedHeader({ alg: algorithm })
      .sign(algorithm === 'RS256' ? privateKey : randomBytes(32));
  }
  assert.equal(
    (await verifyAccessToken(await fixture(), publicKey, config)).subject,
    'synthetic-subject',
  );
  for (const overrides of [
    { iss: 'https://untrusted.invalid' },
    { aud: CLIENT_IDS[0] },
    { exp: now - 30 },
    { exp: undefined },
    { sub: undefined },
    { typ: 'ID' },
    { azp: 'unknown-client' },
    { nbf: now + 300 },
  ]) {
    await assert.rejects(
      verifyAccessToken(await fixture(overrides), publicKey, config),
    );
  }
  await assert.rejects(
    verifyAccessToken(await fixture({}, 'HS256'), publicKey, config),
  );
});
