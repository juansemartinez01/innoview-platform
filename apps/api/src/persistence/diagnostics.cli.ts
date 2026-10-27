import { initializeDirectoryMaintenanceDataSource } from './data-sources.js';
import {
  directoryDifferences,
  securityInvariants,
} from './security-diagnostics.js';
try {
  const source = await initializeDirectoryMaintenanceDataSource();
  try {
    const invariants = await securityInvariants(source);
    const directory = await source.transaction(
      'REPEATABLE READ',
      async (manager) => {
        await manager.query('SET TRANSACTION READ ONLY');
        return directoryDifferences(manager);
      },
    );
    console.log(
      JSON.stringify({
        tables: invariants.tables,
        findings: invariants.findings,
        directoryDifferences: directory.length,
        directoryIssueTypes: [
          ...new Set(directory.flatMap((row) => row.issues)),
        ],
      }),
    );
    if (invariants.findings.length || directory.length) process.exitCode = 1;
  } finally {
    await source.destroy();
  }
} catch {
  console.error(
    'Security diagnostics unavailable; verify operator configuration. Details omitted.',
  );
  process.exitCode = 1;
}
