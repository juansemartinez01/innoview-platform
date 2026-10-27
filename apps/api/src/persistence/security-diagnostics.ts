import type { DataSource, EntityManager } from 'typeorm';

const knownSchemas = [
  'foundation',
  'platform_meta',
  'identity',
  'organizations',
  'memberships',
  'portal_sessions',
  'control_sessions',
  'authorization',
];
const privateOrganizations = [
  'tenant',
  'business_group',
  'organizational_unit',
  'company',
  'branch',
];
const columns = [
  'tenant_id',
  'tenant_name',
  'group_id',
  'group_name',
  'available',
];
const compact = (value: string | null) => value?.replace(/\s+/g, '');
const safeUuid = (setting: string) =>
  `CASE WHEN (current_setting('innoview.${setting}'::text, true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text) THEN (current_setting('innoview.${setting}'::text, true))::uuid ELSE NULL::uuid END`;
const identityQual = `(user_identity_id = ${safeUuid('user_identity_id')})`;
const directoryQual = `(available AND (EXISTS ( SELECT 1 FROM memberships.membership m WHERE ((m.tenant_id = tenant_directory.tenant_id) AND ((m.status)::text = 'ACTIVE'::text) AND (m.user_identity_id = ${safeUuid('user_identity_id')})))))`;
const tenantQual = (table: string) =>
  `((${table === 'tenant' ? 'id' : 'tenant_id'} = ${safeUuid('tenant_id')}) AND (EXISTS ( SELECT 1 FROM organizations.tenant_directory d WHERE ((d.tenant_id = ${table}.${table === 'tenant' ? 'id' : 'tenant_id'}) AND d.available))))`;

const authorizationScoped = [
  'role',
  'role_permission',
  'role_assignment',
  'tenant_revision',
  'operation',
  'audit_event',
];
const authorizationCatalog = ['permission', 'catalog_version'];
const authorizationTenantQual =
  "(tenant_id = CASE WHEN (current_setting('innoview.tenant_id'::text, true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text) THEN (current_setting('innoview.tenant_id'::text, true))::uuid ELSE NULL::uuid END)";
const authorizationAppQual = (table: string) => {
  const base = `(${authorizationTenantQual} AND (EXISTS ( SELECT 1 FROM organizations.tenant_directory d WHERE ((d.tenant_id = ${table}.tenant_id) AND d.available))))`;
  return table === 'role_assignment'
    ? `${base.slice(0, -1)} AND (EXISTS ( SELECT 1 FROM memberships.membership m WHERE ((m.tenant_id = role_assignment.tenant_id) AND (m.id = role_assignment.membership_id)))))`
    : base;
};
// Inventory-driven: all relations and every live column are inspected. Unknown
// tables receive no runtime permissions until explicitly classified here.
export async function securityInvariants(source: DataSource) {
  return source.transaction('REPEATABLE READ', async (manager) => {
    await manager.query('SET TRANSACTION READ ONLY');
    const ownedSchemas = await manager.query<{ name: string }[]>(
      "SELECT n.nspname AS name FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE shobj_description(r.oid,'pg_authid')='innoview:'||current_database()||':migrator'",
    );
    // New schemas owned by the managed migrator enter the inventory too; an
    // added domain cannot silently escape validation by missing a manual list.
    const schemas = [
      ...new Set([...knownSchemas, ...ownedSchemas.map((row) => row.name)]),
    ];
    const findings: string[] = [];
    const roles = await manager.query<
      { name: string; kind: string; unsafe: boolean }[]
    >(`SELECT rolname AS name,split_part(shobj_description(r.oid,'pg_authid'),':',3) AS kind,
      rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
      OR EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid)
      OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid)
      OR has_database_privilege(rolname,current_database(),'CREATE,TEMP')
      OR EXISTS(SELECT 1 FROM pg_namespace WHERE has_schema_privilege(rolname,oid,'CREATE')) AS unsafe
      FROM pg_roles r WHERE shobj_description(r.oid,'pg_authid') LIKE 'innoview:'||current_database()||':%' AND shobj_description(r.oid,'pg_authid') NOT LIKE '%:migrator'`);
    for (const kind of [
      'app',
      'portal',
      'control',
      'membership',
      'organizations',
      'authorization',
    ])
      if (roles.filter((r) => r.kind === kind).length !== 1)
        findings.push(`ROLE_CONTRACT:${kind}`);
    const tables = await manager.query<
      {
        schema: string;
        oid: string;
        name: string;
        rls: boolean;
        force: boolean;
        columns: string[];
      }[]
    >(
      `SELECT n.nspname AS schema,c.oid::text AS oid,c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS force,array_agg(a.attname::text ORDER BY a.attnum) AS columns
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname=ANY($1) AND c.relkind IN ('r','p','v','m','f') GROUP BY n.nspname,c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity ORDER BY n.nspname,c.relname`,
      [schemas],
    );
    const policies = await manager.query<
      {
        schemaname: string;
        tablename: string;
        policyname: string;
        permissive: string;
        roles: string[];
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }[]
    >('SELECT * FROM pg_policies WHERE schemaname=ANY($1)', [schemas]);
    for (const table of tables) {
      const path = `${table.schema}.${table.name}`;
      const isPrivate =
        table.schema === 'organizations' &&
        privateOrganizations.includes(table.name);
      const identityScoped = path === 'memberships.membership';
      const directory = path === 'organizations.tenant_directory';
      const internal =
        table.schema === 'organizations' &&
        ['audit_event', 'operation'].includes(table.name);
      const authScoped =
        table.schema === 'authorization' &&
        authorizationScoped.includes(table.name);
      if (
        (isPrivate || identityScoped || directory || internal || authScoped) &&
        (!table.rls || !table.force)
      )
        findings.push(`RLS_FLAGS:${path}`);
      if (isPrivate || identityScoped || directory) {
        const expected = identityScoped
          ? identityQual
          : directory
            ? directoryQual
            : tenantQual(table.name);
        const app = roles.find((r) => r.kind === 'app')?.name;
        const applicable = policies.filter(
          (p) =>
            p.schemaname === table.schema &&
            p.tablename === table.name &&
            (p.roles.includes(app ?? '') || p.roles.includes('public')),
        );
        for (const [suffix, mode, cmd] of [
          ['boundary', 'RESTRICTIVE', 'ALL'],
          ['select', 'PERMISSIVE', 'SELECT'],
        ]) {
          const policy = applicable.find(
            (p) =>
              p.policyname ===
              (identityScoped ? 'membership_app_' : 'app_') + suffix,
          );
          if (
            !policy ||
            policy.permissive !== mode ||
            policy.cmd !== cmd ||
            compact(policy.qual) !== compact(expected) ||
            policy.with_check !== (suffix === 'boundary' ? 'false' : null)
          )
            findings.push(`POLICY_CONTRACT:${path}:${suffix}`);
        }
        if (applicable.length !== 2)
          findings.push(`ADDITIONAL_APP_POLICY:${path}`);
      }
      if (authScoped) {
        for (const [kind, prefix] of [
          ['authorization', 'operator'],
          ['app', 'app'],
        ]) {
          const actor = roles.find((role) => role.kind === kind)?.name;
          const actual = policies.filter(
            (policy) =>
              policy.schemaname === 'authorization' &&
              policy.tablename === table.name &&
              (policy.roles.includes(actor ?? '') ||
                policy.roles.includes('public')),
          );
          const expected =
            kind === 'authorization'
              ? authorizationTenantQual
              : authorizationAppQual(table.name);
          const names =
            kind === 'authorization'
              ? [
                  'boundary',
                  'select',
                  'insert',
                  ...(table.name === 'audit_event' ? [] : ['update']),
                ]
              : ['operation', 'audit_event'].includes(table.name)
                ? []
                : ['boundary', 'select'];
          if (actual.length !== names.length)
            findings.push(`AUTH_POLICY_COUNT:${kind}:${path}`);
          for (const name of names) {
            const policy = actual.find(
              (value) => value.policyname === `${prefix}_${name}`,
            );
            const command = name === 'boundary' ? 'ALL' : name.toUpperCase();
            const qual = name === 'insert' ? null : expected;
            const check =
              name === 'select' ? null : kind === 'app' ? 'false' : expected;
            if (
              !policy ||
              policy.cmd !== command ||
              policy.permissive !==
                (name === 'boundary' ? 'RESTRICTIVE' : 'PERMISSIVE') ||
              compact(policy.qual) !== compact(qual) ||
              compact(policy.with_check) !== compact(check)
            )
              findings.push(`AUTH_POLICY_CONTRACT:${kind}:${path}:${name}`);
          }
        }
      }
      for (const role of roles) {
        if (role.unsafe) findings.push(`UNSAFE_ROLE:${role.kind}`);
        for (const column of table.columns) {
          const allowed: string[] = [];
          if (role.kind === 'app' && path === 'foundation.persistence_probe')
            allowed.push('SELECT', 'INSERT', 'UPDATE');
          if (role.kind === 'app' && path === 'identity.user_identity')
            allowed.push('SELECT', 'INSERT');
          if (
            role.kind === 'app' &&
            (isPrivate ||
              identityScoped ||
              (directory && columns.includes(column)))
          )
            allowed.push('SELECT');
          if (
            path ===
            `${role.kind === 'portal' ? 'portal_sessions' : role.kind === 'control' ? 'control_sessions' : 'none'}.sessions`
          )
            allowed.push('SELECT', 'INSERT', 'UPDATE');
          if (
            role.kind === 'membership' &&
            table.schema === 'memberships' &&
            ['membership', 'audit_event'].includes(table.name)
          ) {
            allowed.push('SELECT', 'INSERT');
            if (
              table.name === 'membership' &&
              ['status', 'updated_at'].includes(column)
            )
              allowed.push('UPDATE');
          }
          if (
            role.kind === 'organizations' &&
            table.schema === 'organizations' &&
            (isPrivate || directory || internal)
          ) {
            allowed.push('SELECT', 'INSERT');
            if (
              directory ||
              (['tenant', 'organizational_unit'].includes(table.name) &&
                ['status', 'updated_at'].includes(column)) ||
              (table.name === 'operation' &&
                ['tenant_id', 'result', 'completed_at'].includes(column))
            )
              allowed.push('UPDATE');
          }
          if (table.schema === 'authorization') {
            if (
              role.kind === 'app' &&
              (authorizationCatalog.includes(table.name) ||
                [
                  'role',
                  'role_permission',
                  'role_assignment',
                  'tenant_revision',
                ].includes(table.name))
            )
              allowed.push('SELECT');
            if (
              role.kind === 'authorization' &&
              (authorizationCatalog.includes(table.name) || authScoped)
            ) {
              allowed.push('SELECT');
              if (authScoped) allowed.push('INSERT');
              const updates: Record<string, string[]> = {
                role: ['name', 'description', 'status', 'updated_at'],
                role_permission: ['status', 'updated_at'],
                role_assignment: ['status', 'updated_at'],
                tenant_revision: ['revision'],
                operation: ['result', 'completed_at'],
              };
              if (updates[table.name]?.includes(column)) allowed.push('UPDATE');
            }
          }
          const [acl] = await manager.query<
            {
              select: boolean;
              insert: boolean;
              update: boolean;
              references: boolean;
            }[]
          >(
            "SELECT has_column_privilege($1,$2::oid,$3,'SELECT') AS select,has_column_privilege($1,$2::oid,$3,'INSERT') AS insert,has_column_privilege($1,$2::oid,$3,'UPDATE') AS update,has_column_privilege($1,$2::oid,$3,'REFERENCES') AS references",
            [role.name, table.oid, column],
          );
          for (const privilege of [
            'SELECT',
            'INSERT',
            'UPDATE',
            'REFERENCES',
          ] as const)
            if (
              acl[privilege.toLowerCase() as keyof typeof acl] !==
              allowed.includes(privilege)
            )
              findings.push(
                `COLUMN_ACL:${role.kind}:${path}:${column}:${privilege}`,
              );
        }
        const deleteAllowed =
          (role.kind === 'app' && path === 'foundation.persistence_probe') ||
          path ===
            `${role.kind === 'portal' ? 'portal_sessions' : role.kind === 'control' ? 'control_sessions' : 'none'}.sessions`;
        const [acl] = await manager.query<{ del: boolean; danger: boolean }[]>(
          "SELECT has_table_privilege($1,$2::oid,'DELETE') AS del,has_table_privilege($1,$2::oid,'TRUNCATE,TRIGGER,REFERENCES') AS danger",
          [role.name, table.oid],
        );
        if (acl.del !== deleteAllowed || acl.danger)
          findings.push(`TABLE_ACL:${role.kind}:${path}`);
      }
    }
    // Explicit non-RLS exceptions: append-only Identity, role-separated sessions,
    // technical probe/metadata and immutable private Membership audit. No wildcard.
    const exceptions = [
      'foundation.persistence_probe',
      'platform_meta.migrations',
      'platform_meta.typeorm_metadata',
      'identity.user_identity',
      'portal_sessions.sessions',
      'control_sessions.sessions',
      'memberships.audit_event',
      'authorization.permission',
      'authorization.catalog_version',
    ];
    const scopedContracts = [
      ...privateOrganizations.map((name) => `organizations.${name}`),
      'memberships.membership',
      'organizations.tenant_directory',
      'organizations.audit_event',
      'organizations.operation',
      ...authorizationScoped.map((table) => `authorization.${table}`),
    ];
    const expected = new Set([...exceptions, ...scopedContracts]);
    for (const path of expected)
      if (!tables.some((table) => `${table.schema}.${table.name}` === path))
        findings.push(`MISSING_TABLE:${path}`);
    for (const table of tables)
      if (!expected.has(`${table.schema}.${table.name}`))
        findings.push(`UNCLASSIFIED_CONTRACT:${table.schema}.${table.name}`);
    for (const table of tables)
      if (!table.rls && !exceptions.includes(`${table.schema}.${table.name}`))
        findings.push(`UNCLASSIFIED_NON_RLS:${table.schema}.${table.name}`);
    const defaults = await manager.query<
      {
        schema: string;
        object_type: string;
        grantee: string;
        privilege_type: string;
      }[]
    >(`SELECT COALESCE(n.nspname,'GLOBAL') AS schema,d.defaclobjtype AS object_type,CASE WHEN x.grantee=0 THEN 'public' ELSE pg_get_userbyid(x.grantee) END AS grantee,x.privilege_type
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) x WHERE x.grantee<>d.defaclrole`);
    for (const acl of defaults) {
      const kind = roles.find((r) => r.name === acl.grantee)?.kind;
      const sessionOrProbe =
        (acl.schema === 'foundation' && kind === 'app') ||
        (acl.schema === 'portal_sessions' && kind === 'portal') ||
        (acl.schema === 'control_sessions' && kind === 'control');
      const allowed =
        (sessionOrProbe &&
          ((acl.object_type === 'r' &&
            ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(
              acl.privilege_type,
            )) ||
            (acl.object_type === 'S' && acl.privilege_type === 'USAGE'))) ||
        (acl.schema === 'identity' &&
          kind === 'app' &&
          acl.object_type === 'r' &&
          ['SELECT', 'INSERT'].includes(acl.privilege_type));
      if (!allowed)
        findings.push(
          `DEFAULT_ACL:${acl.schema}:${kind ?? acl.grantee}:${acl.privilege_type}`,
        );
    }
    const unsafeFunctions = await manager.query<{ name: string }[]>(
      "SELECT n.nspname||'.'||p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY($1) AND p.prosecdef",
      [schemas],
    );
    for (const fn of unsafeFunctions)
      findings.push(`SECURITY_DEFINER:${fn.name}`);
    for (const role of roles) {
      const permitted =
        role.kind === 'app'
          ? [
              'foundation',
              'identity',
              'organizations',
              'memberships',
              'authorization',
            ]
          : role.kind === 'portal'
            ? ['portal_sessions']
            : role.kind === 'control'
              ? ['control_sessions']
              : role.kind === 'membership'
                ? ['memberships']
                : role.kind === 'organizations'
                  ? ['organizations']
                  : role.kind === 'authorization'
                    ? ['authorization']
                    : [];
      const usages = await manager.query<{ name: string; usage: boolean }[]>(
        "SELECT nspname AS name,has_schema_privilege($1,oid,'USAGE') AS usage FROM pg_namespace WHERE nspname=ANY($2)",
        [role.name, [...schemas, 'public']],
      );
      for (const schema of usages)
        if (schema.usage !== permitted.includes(schema.name))
          findings.push(`SCHEMA_ACL:${role.kind}:${schema.name}`);
      const functions = await manager.query<{ name: string }[]>(
        "SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY($1) AND has_function_privilege($2,p.oid,'EXECUTE')",
        [schemas, role.name],
      );
      for (const fn of functions)
        if (!(
          role.kind === 'authorization' &&
          fn.name === 'authorization.require_operation()'
        ))
          findings.push(`FUNCTION_ACL:${role.kind}:${fn.name}`);
      if (
        role.kind === 'authorization' &&
        !functions.some((fn) => fn.name === 'authorization.require_operation()')
      )
        findings.push(
          'FUNCTION_REQUIRED:authorization:authorization.require_operation()',
        );
      const sequences = await manager.query<
        { name: string; usage: boolean; read: boolean; write: boolean }[]
      >(
        "SELECT n.nspname||'.'||c.relname AS name,has_sequence_privilege($2,c.oid,'USAGE') AS usage,has_sequence_privilege($2,c.oid,'SELECT') AS read,has_sequence_privilege($2,c.oid,'UPDATE') AS write FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1) AND c.relkind='S'",
        [schemas, role.name],
      );
      for (const sequence of sequences)
        if (
          sequence.usage !==
            (role.kind === 'app' &&
              sequence.name === 'foundation.persistence_probe_id_seq') ||
          sequence.read ||
          sequence.write
        )
          findings.push(`SEQUENCE_ACL:${role.kind}:${sequence.name}`);
    }
    return {
      tables: tables.map((t) => ({
        schema: t.schema,
        name: t.name,
        contract: exceptions.includes(`${t.schema}.${t.name}`)
          ? 'EXPLICIT_NON_RLS'
          : scopedContracts.includes(`${t.schema}.${t.name}`)
            ? 'SCOPED_RLS'
            : 'UNCLASSIFIED',
        rls: t.rls,
        force: t.force,
      })),
      findings: [...new Set(findings)],
    };
  });
}

export async function directoryDifferences(manager: EntityManager) {
  if (!manager.queryRunner?.isTransactionActive)
    throw new Error('Active diagnostic transaction required');
  const [actor] = await manager.query<{ trusted: boolean }[]>(
    "SELECT shobj_description(oid,'pg_authid')='innoview:'||current_database()||':organizations' AS trusted FROM pg_roles WHERE rolname=current_user",
  );
  if (!actor?.trusted)
    throw new Error('Organizations operator required for complete diagnosis');
  return manager.query<
    { tenant_id: string; issues: string[] }[]
  >(`WITH expected AS (
    SELECT t.id AS tenant_id,t.name AS tenant_name,g.id AS group_id,u.name AS group_name,t.status='ACTIVE' AND u.status='ACTIVE' AS available
    FROM organizations.tenant t LEFT JOIN organizations.business_group g ON g.tenant_id=t.id
    LEFT JOIN organizations.organizational_unit u ON u.tenant_id=g.tenant_id AND u.id=g.id AND u.type='GROUP')
    SELECT COALESCE(e.tenant_id,d.tenant_id) AS tenant_id,array_remove(ARRAY[
      CASE WHEN e.tenant_id IS NULL THEN 'UNEXPECTED' END,CASE WHEN d.tenant_id IS NULL THEN 'MISSING' END,
      CASE WHEN e.tenant_name IS DISTINCT FROM d.tenant_name THEN 'TENANT_NAME' END,
      CASE WHEN e.group_id IS DISTINCT FROM d.group_id THEN 'GROUP_ID' END,
      CASE WHEN e.group_name IS DISTINCT FROM d.group_name THEN 'GROUP_NAME' END,
      CASE WHEN e.available IS DISTINCT FROM d.available THEN 'AVAILABILITY' END],NULL) AS issues
    FROM expected e FULL OUTER JOIN organizations.tenant_directory d ON d.tenant_id=e.tenant_id
    WHERE ROW(e.tenant_id,e.tenant_name,e.group_id,e.group_name,e.available) IS DISTINCT FROM ROW(d.tenant_id,d.tenant_name,d.group_id,d.group_name,d.available)
    ORDER BY COALESCE(e.tenant_id,d.tenant_id)`);
}
