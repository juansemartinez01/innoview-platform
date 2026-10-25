import { provisionDatabase } from './provision.js';

provisionDatabase()
  .then(() => {
    console.log(
      'Database roles and schema privileges provisioned. No data removed.',
    );
  })
  .catch(() => {
    console.error(
      'Provisioning failed. Check local configuration and ownership; credentials and queries are omitted.',
    );
    process.exitCode = 1;
  });
