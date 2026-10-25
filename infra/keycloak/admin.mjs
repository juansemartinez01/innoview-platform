import { desiredRealm, differences, REALM, MANAGER } from './contract.mjs';

export async function administrator(config) {
  if (!config.adminPassword || config.adminPassword.length < 16)
    throw new Error(
      'Set the local Keycloak admin password (minimum 16 characters)',
    );
  const response = await fetch(
    `${config.baseUrl}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: config.adminUser,
        password: config.adminPassword,
      }),
    },
  );
  if (!response.ok)
    throw new Error(
      `Local Keycloak administration authentication failed (${response.status}); credentials omitted`,
    );
  const { access_token: token } = await response.json();
  if (typeof token !== 'string')
    throw new Error('Invalid administration response');
  return async function request(path, { method = 'GET', body } = {}) {
    const result = await fetch(`${config.baseUrl}/admin/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
    if ([204, 201, 404, 409].includes(result.status))
      return { status: result.status };
    if (!result.ok)
      throw new Error(
        `Keycloak administrative operation failed (${result.status}); response body omitted`,
      );
    return { status: result.status, data: await result.json() };
  };
}

export async function inspectRealm(request, expected = desiredRealm()) {
  const realm = await request(`realms/${REALM}`);
  if (realm.status === 404) return { exists: false, differences: [] };
  if (realm.data?.attributes?.['innoview.managed-by'] !== MANAGER)
    throw new Error(
      'Existing innoview realm is not managed by this project; preserved without changes',
    );
  const { clients, clientScopes, ...realmFields } = expected;
  const drift = differences(realmFields, realm.data, 'realm');
  for (const client of clients) {
    const { data: matches } = await request(
      `realms/${REALM}/clients?clientId=${encodeURIComponent(client.clientId)}`,
    );
    if (!Array.isArray(matches) || matches.length !== 1) {
      drift.push(`client:${client.clientId}:missing-or-ambiguous`);
      continue;
    }
    const { data: actual } = await request(
      `realms/${REALM}/clients/${matches[0].id}`,
    );
    drift.push(...differences(client, actual, `client:${client.clientId}`));
    if (
      actual.authorizationServicesEnabled ||
      Object.keys(actual.authenticationFlowBindingOverrides ?? {}).length
    )
      drift.push(
        `client:${client.clientId}:unexpected-authorization-or-flow-override`,
      );
    const { data: directMappers } = await request(
      `realms/${REALM}/clients/${matches[0].id}/protocol-mappers/models`,
    );
    if (directMappers.length)
      drift.push(`client:${client.clientId}:unexpected-direct-mappers`);
    const { data: defaults } = await request(
      `realms/${REALM}/clients/${matches[0].id}/default-client-scopes`,
    );
    const { data: optional } = await request(
      `realms/${REALM}/clients/${matches[0].id}/optional-client-scopes`,
    );
    drift.push(
      ...differences(
        {
          defaultClientScopes: client.defaultClientScopes,
          optionalClientScopes: client.optionalClientScopes,
        },
        {
          defaultClientScopes: defaults.map((scope) => scope.name),
          optionalClientScopes: optional.map((scope) => scope.name),
        },
        `scopes:${client.clientId}`,
      ),
    );
  }
  const { data: scopes } = await request(`realms/${REALM}/client-scopes`);
  const actualScope = scopes.find(
    (scope) => scope.name === clientScopes[0].name,
  );
  if (!actualScope) drift.push('audience-scope:missing');
  else {
    const { protocolMappers, ...scopeFields } = clientScopes[0];
    drift.push(...differences(scopeFields, actualScope, 'audience-scope'));
    const { data: mappers } = await request(
      `realms/${REALM}/client-scopes/${actualScope.id}/protocol-mappers/models`,
    );
    for (const expected of protocolMappers) {
      const mapper = mappers.find((item) => item.name === expected.name);
      drift.push(...differences(expected, mapper, `mapper:${expected.name}`));
    }
    if (mappers.length !== protocolMappers.length)
      drift.push('audience-scope:unexpected-mappers');
  }
  return { exists: true, differences: [...new Set(drift)] };
}

export async function provisionRealm(request) {
  let state = await inspectRealm(request);
  if (!state.exists) {
    const result = await request('realms', {
      method: 'POST',
      body: desiredRealm(),
    });
    if (![201, 409].includes(result.status))
      throw new Error('Realm creation did not succeed');
    state = await inspectRealm(request);
  }
  if (!state.exists || state.differences.length)
    throw new Error(
      `OIDC configuration drift; no existing settings overwritten. Fields: ${state.differences.join(', ')}`,
    );
  return state;
}
