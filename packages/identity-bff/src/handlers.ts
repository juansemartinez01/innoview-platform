import { randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { cookies } from 'next/headers.js';
import { getIronSession } from 'iron-session';
import * as oidc from 'openid-client';
import { configuration, type App } from './config.js';
import { Store, hash, random, type Payload, type Row } from './store.js';

const instances = new Map<App, Promise<Store>>();
const clients = new Map<App, Promise<oidc.Configuration>>();
async function storeFor(app: App) {
  if (!instances.has(app)) {
    const promise = new Store(configuration(app)).open();
    instances.set(app, promise);
    void promise.catch(() => instances.delete(app));
  }
  return instances.get(app)!;
}
async function clientFor(store: Store) {
  const { config } = store;
  if (!clients.has(config.app)) {
    const promise = oidc
      .discovery(
        new URL(config.issuer),
        config.clientId,
        { id_token_signed_response_alg: 'RS256' },
        oidc.None(),
        {
          timeout: 5,
          execute: config.http ? [oidc.allowInsecureRequests] : [],
        },
      )
      .then((client) => {
        client.timeout = 5;
        oidc.enableNonRepudiationChecks(client);
        return client;
      });
    clients.set(config.app, promise);
    void promise.catch(() => clients.delete(config.app));
  }
  return clients.get(config.app)!;
}
function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function json(data: object, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
function redirect(url: string) {
  return new Response(null, {
    status: 303,
    headers: {
      location: url,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
async function csrf(request: Request, store: Store, row: Row) {
  if (
    request.headers.get('origin') !== store.config.origin ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    throw new Error('CSRF');
  if (Number(request.headers.get('content-length') ?? 0) > 4096)
    throw new Error('CSRF');
  const form = await request.formData();
  const token = form.get('csrf');
  if (typeof token !== 'string' || !equal(token, store.unseal(row).csrf))
    throw new Error('CSRF');
  // Only the fixed application root is a supported return destination.
  if (form.has('returnTo') && form.get('returnTo') !== '/')
    throw new Error('Redirect');
  return form;
}

async function liveSession(
  store: Store,
  id: string,
): Promise<Payload | undefined> {
  // The persisted lease coordinates independent Node processes. Never reclaim an
  // expired lease: its remote refresh may have succeeded before a process crash.
  for (let attempt = 0; attempt < 240; attempt++) {
    const row = await store.read(id);
    if (!row || row.kind !== 'session') return undefined;
    if (row.lease_id) {
      if (!row.lease_until || row.lease_until.getTime() <= Date.now()) {
        await store.revoke(id);
        return undefined;
      }
      await pause(25);
      continue;
    }
    if (row.access_until && row.access_until.getTime() > Date.now() + 30000) {
      await store.source.query(
        `UPDATE ${store.table} SET idle_until=LEAST(expires_at,now()+interval '30 minutes') WHERE id_hash=$1 AND idle_until>now() AND expires_at>now()`,
        [hash(id)],
      );
      return store.unseal(row);
    }
    const lease = randomUUID();
    const [claimed] = await store.source.query<[Row[], number]>(
      `UPDATE ${store.table} SET lease_id=$2,lease_until=now()+interval '15 seconds' WHERE id_hash=$1 AND version=$3 AND lease_id IS NULL AND idle_until>now() AND expires_at>now() RETURNING *`,
      [hash(id), lease, row.version],
    );
    if (!claimed.length) continue;
    try {
      const old = store.unseal(claimed[0]);
      if (!old.refresh) throw new Error('No refresh');
      const tokens = await oidc.refreshTokenGrant(
        await clientFor(store),
        old.refresh,
      );
      const claims = tokens.claims();
      if (
        !tokens.refresh_token ||
        !tokens.expires_in ||
        (claims && (claims.sub !== old.subject || claims.iss !== old.issuer))
      )
        throw new Error('Invalid refresh');
      const updated = {
        ...old,
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        idToken: tokens.id_token ?? old.idToken,
      };
      const [saved] = await store.source.query<[Row[], number]>(
        `UPDATE ${store.table} SET encrypted=$3,access_until=now()+$4*interval '1 second',idle_until=LEAST(expires_at,now()+interval '30 minutes'),version=version+1,lease_id=NULL,lease_until=NULL WHERE id_hash=$1 AND lease_id=$2 AND lease_until>now() AND expires_at>now() AND idle_until>now() RETURNING *`,
        [
          hash(id),
          lease,
          store.seal(updated, hash(id)),
          Math.min(tokens.expires_in, 300),
        ],
      );
      if (!saved.length) throw new Error('Session no longer active');
      return updated;
    } catch {
      await store.revoke(id);
      return undefined;
    }
  }
  return undefined;
}

export async function handle(app: App, request: Request): Promise<Response> {
  try {
    const store = await storeFor(app);
    const { config } = store;
    let cookie = await getIronSession<{ id?: string }>(
      await cookies(),
      config.cookie,
    );
    const url = new URL(request.url);
    const path = url.pathname;
    const row = cookie.id ? await store.read(cookie.id) : undefined;
    if (path === '/auth/callback' && request.method === 'GET') {
      if (!row || row.kind !== 'login')
        return json({ error: 'Invalid authentication transaction' }, 400);
      const consumed = cookie.id ? await store.consume(cookie.id) : undefined;
      cookie.destroy();
      if (!consumed || consumed.kind !== 'login')
        return json({ error: 'Invalid authentication transaction' }, 400);
      try {
        const data = store.unseal(consumed);
        const callback = new URL(`/auth/callback${url.search}`, config.origin);
        const tokens = await oidc.authorizationCodeGrant(
          await clientFor(store),
          callback,
          {
            pkceCodeVerifier: data.verifier!,
            expectedState: data.state!,
            expectedNonce: data.nonce!,
            idTokenExpected: true,
          },
        );
        const claims = tokens.claims();
        if (
          !claims ||
          claims.iss !== config.issuer ||
          !claims.sub ||
          !tokens.refresh_token ||
          !tokens.expires_in
        )
          throw new Error('Invalid identity');
        const registered = await fetch(`${config.apiOrigin}/identity/me`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${tokens.access_token}` },
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (!registered.ok) throw new Error('Local identity unavailable');
        cookie = await getIronSession<{ id?: string }>(
          await cookies(),
          config.cookie,
        );
        cookie.id = await store.create(
          'session',
          {
            csrf: random(),
            issuer: claims.iss,
            subject: claims.sub,
            access: tokens.access_token,
            refresh: tokens.refresh_token,
            idToken: tokens.id_token,
          },
          28800,
          Math.min(tokens.expires_in, 300),
        );
        await cookie.save();
        return redirect(`${config.origin}/`);
      } catch {
        return json({ error: 'Authentication failed; start a new login' }, 400);
      }
    }
    if (path === '/auth/logout/callback' && request.method === 'GET') {
      if (!row || row.kind !== 'logout')
        return json({ error: 'Invalid logout transaction' }, 400);
      const consumed = cookie.id ? await store.consume(cookie.id) : undefined;
      cookie.destroy();
      if (
        !consumed ||
        consumed.kind !== 'logout' ||
        !equal(
          url.searchParams.getAll('state').length === 1
            ? (url.searchParams.get('state') ?? '')
            : '',
          store.unseal(consumed).state!,
        )
      )
        return json({ error: 'Invalid logout transaction' }, 400);
      return redirect(`${config.origin}/`);
    }
    if (path === '/auth/session' && request.method === 'GET') {
      const live =
        row?.kind === 'session' && cookie.id
          ? await liveSession(store, cookie.id)
          : undefined;
      if (live) {
        let response = await fetch(`${config.apiOrigin}/identity/me`, {
          headers: { Authorization: `Bearer ${live.access}` },
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (response.status === 404) {
          // Upgrade an already authenticated 1.2 session without discarding it.
          // API independently validates the access token before resolving UUID.
          response = await fetch(`${config.apiOrigin}/identity/me`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${live.access}` },
            cache: 'no-store',
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
          });
        }
        if (!response.ok) {
          if (response.status === 401 && cookie.id) {
            await store.revoke(cookie.id);
            cookie.destroy();
          }
          return json(
            { error: 'Identity verification unavailable' },
            response.status === 401 ? 401 : 503,
          );
        }
        const identity = (await response.json()) as {
          issuer?: string;
          subject?: string;
          id?: string;
          externalSubject?: string;
        };
        if (
          identity.issuer !== config.issuer ||
          identity.externalSubject !== live.subject ||
          typeof identity.id !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            identity.id,
          )
        )
          throw new Error('Identity mismatch');
        return json({
          authenticated: true,
          identity: {
            issuer: identity.issuer,
            id: identity.id,
            subject: identity.externalSubject,
            clientId: config.clientId,
          },
          csrf: live.csrf,
        });
      }
      if (row?.kind !== 'anonymous') {
        if (cookie.id) await store.revoke(cookie.id);
        cookie.id = await store.create('anonymous', { csrf: random() }, 300);
        await cookie.save();
      }
      const anonymous = await store.read(cookie.id!);
      return json({
        authenticated: false,
        csrf: store.unseal(anonymous).csrf,
      });
    }
    if (
      request.method === 'POST' &&
      ['/auth/login', '/auth/logout'].includes(path)
    ) {
      if (!row || !cookie.id || !['session', 'anonymous'].includes(row.kind))
        return json({ error: 'Session required' }, 403);
      let form: FormData;
      try {
        form = await csrf(request, store, row);
      } catch {
        return json({ error: 'Invalid request' }, 403);
      }
      if (path === '/auth/login') {
        const client = await clientFor(store);
        const state = oidc.randomState();
        const nonce = oidc.randomNonce();
        const verifier = oidc.randomPKCECodeVerifier();
        const login = oidc.buildAuthorizationUrl(client, {
          redirect_uri: `${config.origin}/auth/callback`,
          scope: 'openid',
          state,
          nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
          code_challenge_method: 'S256',
        });
        await store.revoke(cookie.id);
        cookie.id = await store.create(
          'login',
          { csrf: random(), state, nonce, verifier },
          300,
        );
        await cookie.save();
        return redirect(login.href);
      }
      const data = store.unseal(row);
      await store.revoke(cookie.id);
      cookie.destroy();
      if (form.get('sso') !== 'true' || row.kind !== 'session')
        return redirect(`${config.origin}/`);
      // No ID token in browser/URL: Keycloak accepts client_id plus a registered
      // post-logout URI, and asks the user to confirm SSO logout at the IdP.
      const client = await clientFor(store);
      const state = oidc.randomState();
      const logout = oidc.buildEndSessionUrl(client, {
        client_id: config.clientId,
        post_logout_redirect_uri: `${config.origin}/auth/logout/callback`,
        state,
      });
      // Keycloak returns directly to the server handler; no client-side relay.
      cookie = await getIronSession<{ id?: string }>(
        await cookies(),
        config.cookie,
      );
      cookie.id = await store.create('logout', { csrf: data.csrf, state }, 300);
      await cookie.save();
      return redirect(logout.href);
    }
    return json({ error: 'Not found' }, 404);
  } catch {
    // Never log request URLs, headers, provider errors, token responses or SQL.
    console.error('Authentication operation failed; sensitive details omitted');
    return json({ error: 'Authentication unavailable' }, 503);
  }
}
