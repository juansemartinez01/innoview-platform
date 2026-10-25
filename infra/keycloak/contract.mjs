export const REALM = 'innoview';
export const API_AUDIENCE = 'innoview-api';
export const MANAGER = 'innoview-platform/oidc-v1';
export const CLIENT_IDS = ['innoview-portal', 'innoview-control-center'];

export function configuration(env = process.env, test = false) {
  const text = test
    ? env.TEST_KEYCLOAK_PORT
    : (env.KEYCLOAK_HTTP_PORT ?? '8080');
  if (!text || !/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 65535)
    throw new Error('Invalid Keycloak port');
  if (
    test &&
    (Number(text) < 10000 ||
      Number(text) === Number(env.KEYCLOAK_HTTP_PORT ?? '8080'))
  )
    throw new Error('OIDC tests require a separate high-port Keycloak');
  const baseUrl = `http://127.0.0.1:${Number(text)}`;
  return {
    baseUrl,
    issuer: `${baseUrl}/realms/${REALM}`,
    adminUser: test
      ? 'test_admin'
      : (env.KEYCLOAK_ADMIN_USERNAME ?? 'local_admin'),
    adminPassword: test
      ? env.TEST_KEYCLOAK_ADMIN_PASSWORD
      : env.KEYCLOAK_ADMIN_PASSWORD,
  };
}

export function desiredRealm(version = 2) {
  if (![1, 2].includes(version))
    throw new Error('Unsupported OIDC contract version');
  const clients = CLIENT_IDS.map((clientId, index) => {
    const origin = `http://127.0.0.1:${3000 + index}`;
    return {
      clientId,
      enabled: true,
      protocol: 'openid-connect',
      publicClient: true,
      bearerOnly: false,
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      fullScopeAllowed: false,
      consentRequired: false,
      frontchannelLogout: false,
      redirectUris: [`${origin}/auth/callback`],
      webOrigins: [origin],
      defaultClientScopes: ['innoview-api-access'],
      optionalClientScopes: [],
      attributes: {
        'innoview.managed-by': MANAGER,
        'pkce.code.challenge.method': 'S256',
        'post.logout.redirect.uris':
          version === 1 ? `${origin}/` : `${origin}/auth/logout/callback`,
        'oauth2.device.authorization.grant.enabled': 'false',
        'oidc.ciba.grant.enabled': 'false',
        'standard.token.exchange.enabled': 'false',
        'id.token.signed.response.alg': 'RS256',
        'access.token.signed.response.alg': 'RS256',
      },
    };
  });
  return {
    realm: REALM,
    enabled: true,
    sslRequired: 'none',
    registrationAllowed: false,
    resetPasswordAllowed: false,
    rememberMe: false,
    loginWithEmailAllowed: false,
    bruteForceProtected: true,
    defaultSignatureAlgorithm: 'RS256',
    accessTokenLifespan: 300,
    accessCodeLifespan: 60,
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: 28800,
    revokeRefreshToken: true,
    refreshTokenMaxReuse: 0,
    attributes: {
      'innoview.managed-by': MANAGER,
      'innoview.contract-version': String(version),
    },
    clientScopes: [
      {
        name: 'innoview-api-access',
        protocol: 'openid-connect',
        attributes: {
          'include.in.token.scope': 'false',
          'display.on.consent.screen': 'false',
        },
        protocolMappers: [
          {
            name: 'innoview-subject',
            protocol: 'openid-connect',
            protocolMapper: 'oidc-sub-mapper',
            consentRequired: false,
            config: {
              'access.token.claim': 'true',
              'introspection.token.claim': 'true',
            },
          },
          {
            name: 'innoview-api-audience',
            protocol: 'openid-connect',
            protocolMapper: 'oidc-audience-mapper',
            consentRequired: false,
            config: {
              'included.client.audience': API_AUDIENCE,
              'access.token.claim': 'true',
              'id.token.claim': 'false',
              'introspection.token.claim': 'true',
            },
          },
        ],
      },
    ],
    clients: [
      ...clients,
      {
        clientId: API_AUDIENCE,
        enabled: true,
        protocol: 'openid-connect',
        publicClient: false,
        bearerOnly: true,
        standardFlowEnabled: false,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        fullScopeAllowed: false,
        redirectUris: [],
        webOrigins: [],
        defaultClientScopes: [],
        optionalClientScopes: [],
        attributes: { 'innoview.managed-by': MANAGER },
      },
    ],
  };
}

// Compare controlled fields only; Keycloak adds IDs and built-in defaults.
export function differences(expected, actual, path = '') {
  const result = [];
  for (const [key, value] of Object.entries(expected)) {
    const name = path ? `${path}.${key}` : key;
    if (Array.isArray(value)) {
      if (
        !Array.isArray(actual?.[key]) ||
        JSON.stringify([...value].sort()) !==
          JSON.stringify([...actual[key]].sort())
      )
        result.push(name);
    } else if (value && typeof value === 'object') {
      result.push(...differences(value, actual?.[key], name));
    } else if (actual?.[key] !== value) result.push(name);
  }
  return result;
}
