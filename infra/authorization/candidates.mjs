// Benchmark-only SQL prototypes. Never registered as authorization.access@1.
const tenant = `SELECT id FROM organizations.tenant WHERE id=$1 AND status='ACTIVE'`;
const member = `SELECT id FROM memberships.membership WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'`;
const units = `SELECT u.tenant_id,u.id,u.type FROM organizations.organizational_unit u
 JOIN checked_tenant t ON t.id=u.tenant_id
 JOIN organizations.business_group g ON g.tenant_id=u.tenant_id
 JOIN organizations.organizational_unit gu ON gu.tenant_id=g.tenant_id AND gu.id=g.id AND gu.status='ACTIVE'
 LEFT JOIN organizations.branch b ON b.tenant_id=u.tenant_id AND b.id=u.id AND u.type='BRANCH'
 LEFT JOIN organizations.company c ON c.tenant_id=u.tenant_id AND c.id=CASE WHEN u.type='COMPANY' THEN u.id ELSE b.company_id END
 LEFT JOIN organizations.organizational_unit cu ON cu.tenant_id=c.tenant_id AND cu.id=c.id
 WHERE u.tenant_id=$1 AND u.status='ACTIVE' AND
 ((u.type='GROUP' AND u.id=g.id) OR (u.type IN ('COMPANY','BRANCH') AND cu.status='ACTIVE' AND c.business_group_id=g.id))`;
const grants = `SELECT r.tenant_id,r.id AS role_id,p.id AS permission_id,p.code
 FROM "authorization".role r
 JOIN "authorization".role_permission rp ON rp.tenant_id=r.tenant_id AND rp.role_id=r.id AND rp.status='ACTIVE'
 JOIN "authorization".permission p ON p.id=rp.permission_id AND p.status='ACTIVE'
 WHERE r.tenant_id=$1 AND r.status='ACTIVE'`;

export function candidateQueries(tenantId, membershipId, companyId) {
  const result = [];
  for (const strategy of ['inline', 'materialized']) {
    const materialization =
      strategy === 'materialized' ? 'MATERIALIZED' : 'NOT MATERIALIZED';
    // MATERIALIZED prototype consumes the tenant validated by the CURRENT
    // TenantReadTransactions invocation. It does not perform a second owner
    // availability read. RLS still checks directory/membership on every table.
    const checkedTenant =
      strategy === 'materialized' ? 'SELECT $1::uuid AS id' : tenant;
    const prefix = `WITH checked_tenant AS ${materialization} (${checkedTenant}), checked_member AS ${materialization} (${member}), available_units AS ${materialization} (${units}), grants AS ${materialization} (${grants}),
      checked_assignments AS ${materialization} (SELECT a.* FROM "authorization".role_assignment a JOIN checked_member m ON m.id=a.membership_id WHERE a.tenant_id=$1 AND a.membership_id=$2 AND a.status='ACTIVE')`;
    const from = `FROM checked_assignments a
      JOIN checked_member m ON m.id=a.membership_id
      JOIN grants g ON g.tenant_id=a.tenant_id AND g.role_id=a.role_id
      JOIN available_units u ON u.tenant_id=a.tenant_id AND u.id=a.scope_unit_id AND u.type=a.scope_type
      WHERE a.tenant_id=$1 AND a.membership_id=$2 AND a.status='ACTIVE'`;
    for (const [name, projection, filter, params] of [
      [
        'permissions',
        'DISTINCT g.permission_id,g.code',
        '',
        [tenantId, membershipId],
      ],
      [
        'scopes',
        'DISTINCT a.scope_type,a.scope_unit_id',
        ' AND g.code=$3',
        [tenantId, membershipId, 'foundation.probe.read'],
      ],
      [
        'exact',
        '1',
        ' AND g.code=$3 AND a.scope_type=$4 AND a.scope_unit_id=$5',
        [tenantId, membershipId, 'foundation.probe.read', 'COMPANY', companyId],
      ],
    ])
      result.push({
        strategy,
        name,
        sql:
          prefix +
          (name === 'exact'
            ? ` SELECT EXISTS(SELECT ${projection} ${from}${filter}) AS allowed`
            : ` SELECT ${projection} ${from}${filter}`),
        params,
      });
  }
  return result;
}

export function planNodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)];
}
export function summarizePlan(plan) {
  const nodes = planNodes(plan.Plan).map((n) => ({
    type: n['Node Type'],
    relation: n['Relation Name'],
    alias: n.Alias,
    index: n['Index Name'],
    subplan: n['Subplan Name'],
    estimatedRows: n['Plan Rows'],
    actualRows: n['Actual Rows'],
    loops: n['Actual Loops'],
    sharedHits: n['Shared Hit Blocks'],
    sharedReads: n['Shared Read Blocks'],
    indexCond: n['Index Cond'],
    filter: n.Filter,
    rowsRemovedByFilter: n['Rows Removed by Filter'],
    rowsRemovedByIndexRecheck: n['Rows Removed by Index Recheck'],
    heapFetches: n['Heap Fetches'],
    actualTotalMs: n['Actual Total Time'],
    totalCost: n['Total Cost'],
    intermediateRows: n['Actual Rows'] * n['Actual Loops'],
    peakMemoryKb: n['Peak Memory Usage'],
    sortSpaceKb: n['Sort Space Used'],
    sortSpaceType: n['Sort Space Type'],
    hashBatches: n['Hash Batches'],
    tempReadBlocks: n['Temp Read Blocks'],
    tempWrittenBlocks: n['Temp Written Blocks'],
  }));
  return {
    executionMs: plan['Execution Time'],
    planningMs: plan['Planning Time'],
    actualRows: plan.Plan['Actual Rows'],
    sharedHits: plan.Plan['Shared Hit Blocks'],
    sharedReads: plan.Plan['Shared Read Blocks'],
    indexes: [...new Set(nodes.flatMap((n) => (n.index ? [n.index] : [])))],
    // Inclusive counters: nested nodes overlap; do not sum as independent cost.
    rlsWork: nodes
      .filter((n) => ['membership', 'tenant_directory'].includes(n.relation))
      .map((n) => ({
        relation: n.relation,
        loops: n.loops,
        actualRows: n.actualRows,
        sharedHits: n.sharedHits,
        sharedReads: n.sharedReads,
        actualTotalMs: n.actualTotalMs,
      })),
    nodes,
    raw: plan,
  };
}
