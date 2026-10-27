import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const reports = await Promise.all(
  ['benchmark-result.json', 'benchmark-wide-result.json'].map(async (name) =>
    JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8')),
  ),
);
assert.deepEqual(
  reports.map((r) => r.permissionsPerRole),
  [2, 40],
);
for (const report of reports) {
  assert.equal(report.tenants, 500);
  assert.equal(report.roleAssignments, 50000);
}
const rows = reports[0].evaluatorMeasurements.map((base) => {
  const wide = reports[1].evaluatorMeasurements.find(
    (row) => row.tenantClass === base.tenantClass && row.method === base.method,
  );
  const plans = reports.map((report) => {
    const plan = report.plans.find(
      (row) =>
        row.tenantClass === base.tenantClass &&
        row.query === 'runtime:' + base.method,
    );
    return {
      permissionsPerRole: report.permissionsPerRole,
      sharedHits: plan.sharedHits,
      sharedReads: plan.sharedReads,
      indexes: plan.indexes,
      nodes: plan.nodes
        .filter(
          (node) =>
            ['role_permission', 'role_assignment'].includes(node.relation) ||
            node.type.includes('Aggregate') ||
            node.type === 'CTE Scan' ||
            node.peakMemoryKb !== undefined ||
            node.sortSpaceKb !== undefined,
        )
        .map((node) => ({
          type: node.type,
          relation: node.relation,
          alias: node.alias,
          actualRows: node.actualRows,
          loops: node.loops,
          intermediateRows: node.intermediateRows,
          heapFetches: node.heapFetches,
          peakMemoryKb: node.peakMemoryKb,
          sortSpaceKb: node.sortSpaceKb,
          sortSpaceType: node.sortSpaceType,
          hashBatches: node.hashBatches,
          tempReadBlocks: node.tempReadBlocks,
          tempWrittenBlocks: node.tempWrittenBlocks,
        })),
    };
  });
  return {
    tenantClass: base.tenantClass,
    method: base.method,
    narrow: { methodMs: base.queryMs, transactionMs: base.transactionMs },
    wide: { methodMs: wide.queryMs, transactionMs: wide.transactionMs },
    plans,
  };
});
const result = {
  seed: reports[0].seed,
  tenants: 500,
  roleAssignments: 50000,
  rolePermissions: reports.map((report) => ({
    permissionsPerRole: report.permissionsPerRole,
    rows: report.counts.find((row) => row.table === 'role_permission').rows,
  })),
  methodology:
    'Separate discarded databases, same deterministic logical dataset; 3 warmups/30 repetitions; first observations are not OS/PostgreSQL-cold. Inclusive plan counters overlap. No SLA or CI timing thresholds.',
  rows,
};
await writeFile(
  new URL('./benchmark-width-comparison.json', import.meta.url),
  JSON.stringify(result, null, 2) + '\n',
);
console.info(
  JSON.stringify(
    result.rows.map((row) => ({
      tenantClass: row.tenantClass,
      method: row.method,
      narrow: row.narrow,
      wide: row.wide,
    })),
  ),
);
