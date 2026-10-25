import * as oidc from 'openid-client';
import { createRemoteJWKSet, importJWK, jwtVerify } from 'jose';
import { API_AUDIENCE, CLIENT_IDS } from './contract.mjs';

export function apiVerifier(config) {
  const jwks = createRemoteJWKSet(
    new URL(`${config.issuer}/protocol/openid-connect/certs`),
    { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 },
  );
  return (token) => verifyAccessToken(token, jwks, config);
}

export async function verifyAccessToken(token, trustedKey, config) {
  const { payload } = await jwtVerify(token, trustedKey, {
    issuer: config.issuer,
    audience: API_AUDIENCE,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'iat', 'exp', 'azp'],
    maxTokenAge: '5m',
    clockTolerance: 5,
  });
  if (
    payload.typ !== 'Bearer' ||
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    !CLIENT_IDS.includes(payload.azp)
  )
    throw new Error('Unexpected access token type or authorized party');
  return { issuer: payload.iss, subject: payload.sub, clientId: payload.azp };
}

export async function verifyPublicEndpoints(config) {
  const response = await fetch(
    `${config.issuer}/.well-known/openid-configuration`,
    { signal: AbortSignal.timeout(10000), redirect: 'error' },
  );
  if (!response.ok) throw new Error('OIDC discovery unavailable');
  const metadata = await response.json();
  if (metadata.issuer !== config.issuer)
    throw new Error('Canonical issuer mismatch');
  for (const key of [
    'authorization_endpoint',
    'token_endpoint',
    'jwks_uri',
    'end_session_endpoint',
  ]) {
    if (
      typeof metadata[key] !== 'string' ||
      !metadata[key].startsWith(`${config.issuer}/protocol/openid-connect/`)
    )
      throw new Error(`Unexpected discovery endpoint: ${key}`);
  }
  if (
    !metadata.code_challenge_methods_supported.includes('S256') ||
    !metadata.id_token_signing_alg_values_supported.includes('RS256')
  )
    throw new Error('Required PKCE/signature algorithms missing');
  const keysResponse = await fetch(metadata.jwks_uri, {
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!keysResponse.ok) throw new Error('JWKS unavailable');
  const keys = (await keysResponse.json()).keys;
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.some((key) =>
      ['d', 'k', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some(
        (field) => field in key,
      ),
    )
  )
    throw new Error('Invalid or non-public JWKS');
  const signingKeys = keys.filter(
    (key) =>
      key.use === 'sig' && key.alg === 'RS256' && key.kty === 'RSA' && key.kid,
  );
  if (!signingKeys.length) throw new Error('No RS256 verification keys');
  for (const key of signingKeys) await importJWK(key, 'RS256');
  // HTTP is explicitly allowed for loopback development only.
  const client = await oidc.discovery(
    new URL(config.issuer),
    CLIENT_IDS[0],
    { id_token_signed_response_alg: 'RS256' },
    oidc.None(),
    { execute: [oidc.allowInsecureRequests] },
  );
  return { metadata, client, signingKeys: signingKeys.length };
}
