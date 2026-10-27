import { createHash } from 'node:crypto';
export const BENCHMARK_SEED = 'innoview-authorization-20261026-v1';
export function seededUuid(label) {
  const h = createHash('sha256')
    .update(BENCHMARK_SEED + ':' + label)
    .digest('hex')
    .slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}`;
}
export function benchmarkTenant(index) {
  const key = `tenant:${index}`,
    id = seededUuid(key),
    groupId = seededUuid(key + ':group');
  const companies = Array.from({ length: index === 0 ? 10 : 2 }, (_, i) => ({
    id: seededUuid(key + ':company:' + i),
    branchId: seededUuid(key + ':branch:' + i),
  }));
  return {
    index,
    id,
    groupId,
    name: `Benchmark tenant ${index}`,
    companies,
    identities: Array.from({ length: index === 0 ? 100 : 3 }, (_, i) => ({
      id: seededUuid(key + ':identity:' + i),
      subject: key + ':identity:' + i,
    })),
    roles: Array.from({ length: index === 0 ? 20 : 4 }, (_, i) => ({
      id: seededUuid(key + ':role:' + i),
      name: `Benchmark role ${i}`,
    })),
    assignments: index === 0 ? 25050 : 50,
  };
}
