import { CLIENT_IDS, REALM, desiredRealm } from './contract.mjs';
import { inspectRealm } from './admin.mjs';

// This is an explicit v1 -> v2 migration, not a reconciliation/force option.
// Only known v1/v2 logout attributes may differ. All managed fields must match.
async function preflight(request) {
  const realm = await request(`realms/${REALM}`);
  if (realm.status !== 200)
    throw new Error('Managed realm must exist before logout migration');
  const version = realm.data?.attributes?.['innoview.contract-version'];
  if (!['1', '2'].includes(version))
    throw new Error('Unsupported existing OIDC contract; preserved');
  const expected = desiredRealm(Number(version));
  const clients = [];
  for (let index = 0; index < CLIENT_IDS.length; index++) {
    const { data: matches } = await request(
      `realms/${REALM}/clients?clientId=${CLIENT_IDS[index]}`,
    );
    if (matches?.length !== 1)
      throw new Error('Missing or ambiguous managed client; preserved');
    const path = `realms/${REALM}/clients/${matches[0].id}`;
    const { data: client } = await request(path);
    const actual = client.attributes?.['post.logout.redirect.uris'];
    const legacy =
      desiredRealm(1).clients[index].attributes['post.logout.redirect.uris'];
    const target =
      desiredRealm(2).clients[index].attributes['post.logout.redirect.uris'];
    if (actual !== target && (version !== '1' || actual !== legacy))
      throw new Error('Unknown logout redirect; preserved');
    expected.clients[index].attributes['post.logout.redirect.uris'] = actual;
    clients.push({ path, client, target });
  }
  const state = await inspectRealm(request, expected);
  if (!state.exists || state.differences.length)
    throw new Error(
      `Logout migration refused due to drift: ${state.differences.join(', ')}`,
    );
  return { realm: realm.data, clients };
}

export async function migrateLogout(request) {
  // IdP Admin REST has no multi-client transaction/CAS. Run in an exclusive
  // maintenance window, without concurrent administrator edits. Recheck before
  // each write and verify afterwards; interrupted v1 states are resumable.
  await preflight(request);
  for (let index = 0; index < CLIENT_IDS.length; index++) {
    const state = await preflight(request);
    const { path, client, target } = state.clients[index];
    if (client.attributes['post.logout.redirect.uris'] === target) continue;
    const response = await request(path, {
      method: 'PUT',
      body: {
        attributes: {
          ...client.attributes,
          'post.logout.redirect.uris': target,
        },
      },
    });
    if (response.status !== 204)
      throw new Error(
        'Logout client migration failed; rerun after reviewing state',
      );
  }
  const { realm } = await preflight(request);
  if (realm.attributes['innoview.contract-version'] !== '2') {
    const response = await request(`realms/${REALM}`, {
      method: 'PUT',
      body: {
        attributes: { ...realm.attributes, 'innoview.contract-version': '2' },
      },
    });
    if (response.status !== 204)
      throw new Error('Logout contract version update failed');
  }
  const state = await inspectRealm(request);
  if (!state.exists || state.differences.length)
    throw new Error(
      'Post-migration OIDC drift; review without forcing updates',
    );
  return state;
}
