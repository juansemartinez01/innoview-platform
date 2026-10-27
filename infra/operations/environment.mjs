import policy from '../../apps/api/src/runtime-environment.policy.json' with { type: 'json' };
export function technicalEnvironment(purpose, input, system = process.env) {
  if (
    ![
      'backup',
      'directory',
      'diagnose',
      'provision-tenant',
      'authorization-bootstrap',
    ].includes(purpose)
  )
    throw new Error('Unknown technical process');
  const kind =
    purpose === 'backup'
      ? 'BOOTSTRAP'
      : ['directory', 'diagnose'].includes(purpose)
        ? 'DIRECTORY_MAINTENANCE'
        : 'ORGANIZATIONS_PROVISIONER';
  const os = [
    ...policy.system,
    ...(purpose === 'backup'
      ? [
          'ProgramFiles',
          'ProgramW6432',
          'ProgramFiles(x86)',
          'ProgramData',
          'ALLUSERSPROFILE',
        ]
      : []),
  ];
  const env = {};
  for (const key of os) if (system[key] !== undefined) env[key] = system[key];
  for (const key of [
    'DB_HOST',
    'DB_PORT',
    'DB_NAME',
    'DB_SSL',
    `DB_${kind}_USER`,
    purpose === 'backup' ? 'PLATFORM_POSTGRES_PASSWORD' : `DB_${kind}_PASSWORD`,
  ])
    if (input[key] !== undefined) env[key] = input[key];
  if (purpose === 'authorization-bootstrap') {
    delete env.DB_ORGANIZATIONS_PROVISIONER_USER;
    delete env.DB_ORGANIZATIONS_PROVISIONER_PASSWORD;
    for (const owner of ['AUTHORIZATION', 'MEMBERSHIP', 'ORGANIZATIONS'])
      for (const suffix of ['USER', 'PASSWORD']) {
        const key = `DB_${owner}_${suffix}`;
        if (input[key] !== undefined) env[key] = input[key];
      }
  }
  return env;
}
