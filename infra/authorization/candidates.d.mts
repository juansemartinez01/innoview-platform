export function candidateQueries(
  tenantId: string,
  membershipId: string,
  companyId: string,
): Array<{ strategy: string; name: string; sql: string; params: string[] }>;
