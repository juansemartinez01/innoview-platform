import type { Row, Store } from './store.js';

export interface ContextOption {
  id: string;
  name: string;
  group: { id: string; name: string };
}
export class ContextFailure extends Error {
  constructor(readonly status: number) {
    super('Context verification unavailable');
  }
}
export const tenantUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function option(value: unknown): ContextOption {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !tenantUuid(value.id) ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !('group' in value) ||
    typeof value.group !== 'object' ||
    value.group === null ||
    !('id' in value.group) ||
    typeof value.group.id !== 'string' ||
    !tenantUuid(value.group.id) ||
    !('name' in value.group) ||
    typeof value.group.name !== 'string'
  )
    throw new ContextFailure(503);
  // Explicit projection: never forward arbitrary API fields to the browser.
  return {
    id: value.id,
    name: value.name,
    group: { id: value.group.id, name: value.group.name },
  };
}
async function core(store: Store, access: string, tenantId?: string) {
  const response = await fetch(
    `${store.config.apiOrigin}/context/${tenantId ? 'validate' : 'options'}`,
    {
      method: tenantId ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${access}`,
        ...(tenantId ? { 'Content-Type': 'application/json' } : {}),
      },
      body: tenantId ? JSON.stringify({ tenantId }) : undefined,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok)
    throw new ContextFailure(
      [401, 404].includes(response.status) ? response.status : 503,
    );
  return response.json() as Promise<unknown>;
}
function revision(row: Row | undefined): number {
  if (!row || row.kind !== 'session') throw new ContextFailure(401);
  if (!Number.isInteger(row.context_revision) || row.context_revision! < 0)
    throw new ContextFailure(503);
  return row.context_revision!;
}

export async function currentContext(store: Store, id: string, access: string) {
  let invalidated = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let row = await store.read(id);
    let version = revision(row);
    const body = await core(store, access);
    if (
      typeof body !== 'object' ||
      body === null ||
      !('options' in body) ||
      !Array.isArray(body.options)
    )
      throw new ContextFailure(503);
    const options = body.options.map(option);
    const selected =
      options.find((item) => item.id === row.selected_tenant_id) ?? null;
    if (row.selected_tenant_id && !selected) {
      const cleared = await store.changeContext(id, version, null);
      if (!cleared) continue;
      row = cleared;
      version = revision(cleared);
      invalidated = true;
    }
    const latest = await store.read(id);
    if (revision(latest) !== version) continue;
    return { options, selected, revision: version, invalidated };
  }
  throw new ContextFailure(409);
}

export async function selectContext(
  store: Store,
  id: string,
  access: string,
  version: number,
  tenantId: string | null,
) {
  const observed = await store.read(id);
  if (revision(observed) !== version) throw new ContextFailure(409);
  let selected: ContextOption | null = null;
  try {
    if (tenantId) selected = option(await core(store, access, tenantId));
  } catch (error) {
    // A rejected re-selection can itself discover that the current preference
    // became invalid. Clear only the observed revision, never a newer choice.
    if (
      error instanceof ContextFailure &&
      error.status === 404 &&
      observed.selected_tenant_id === tenantId
    )
      await store.changeContext(id, version, null);
    throw error;
  }
  if (selected && selected.id !== tenantId) throw new ContextFailure(503);
  const saved = await store.changeContext(id, version, tenantId);
  if (!saved) throw new ContextFailure(409);
  return { selected, revision: revision(saved) };
}
