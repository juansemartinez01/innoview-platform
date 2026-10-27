import type { MigrationInterface, QueryRunner } from 'typeorm';
// Frozen owner-contract SQL at migration 15; later runtime changes must not rewrite history.
function authorizationUnitsSql(exact = false) {
  return `SELECT u.tenant_id,u.id,u.type FROM organizations.organizational_unit u
      JOIN organizations.tenant t ON t.id=u.tenant_id AND t.status='ACTIVE'
      JOIN organizations.business_group g ON g.tenant_id=u.tenant_id
      JOIN organizations.organizational_unit gu ON gu.tenant_id=g.tenant_id AND gu.id=g.id AND gu.type='GROUP' AND gu.status='ACTIVE'
      LEFT JOIN organizations.branch b ON b.tenant_id=u.tenant_id AND b.id=u.id AND u.type='BRANCH'
      LEFT JOIN organizations.company c ON c.tenant_id=u.tenant_id AND c.id=CASE WHEN u.type='COMPANY' THEN u.id ELSE b.company_id END
      LEFT JOIN organizations.organizational_unit cu ON cu.tenant_id=c.tenant_id AND cu.id=c.id AND cu.status='ACTIVE'
      WHERE u.tenant_id=$1 AND u.status='ACTIVE' ${exact ? 'AND u.type=$5 AND u.id=$6' : ''}
      AND ((u.type='GROUP' AND u.id=g.id) OR (u.type IN ('COMPANY','BRANCH') AND cu.id IS NOT NULL AND c.business_group_id=g.id))`;
}

// Frozen owner-contract SQL at migration 15; later runtime changes must not rewrite history.
function authorizationMembershipSql() {
  return "SELECT id,tenant_id FROM memberships.membership WHERE tenant_id=$1 AND id=$2 AND user_identity_id=$3 AND status='ACTIVE'";
}

const uuid = (key: string) =>
  `CASE WHEN current_setting('innoview.${key}',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN current_setting('innoview.${key}',true)::uuid ELSE NULL::uuid END`;
const quote = (s: string) => '"' + s.replaceAll('"', '""') + '"';
const scoped = [
  'role',
  'role_permission',
  'role_assignment',
  'tenant_revision',
  'operation',
  'audit_event',
];
const changed = [
  'require_operation',
  'guard_operation',
  'guard_revision',
  'guard_audit',
];

// SQL and grants are deliberately explicit. No elevated function or runtime role.
export class DelegatedAssignments1793142000000 implements MigrationInterface {
  name = 'DelegatedAssignments1793142000000';
  async up(r: QueryRunner): Promise<void> {
    const [roles] = (await r.query(`SELECT
      (SELECT rolname FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':authorization_delegation') AS delegated,
      (SELECT rolname FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':app') AS app,
      (SELECT rolname FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':authorization') AS technical, current_user AS migrator`)) as {
      delegated: string;
      app: string;
      migrator: string;
      technical: string;
    }[];
    if (!roles.delegated)
      throw new Error(
        'Provision the independent delegation role before migrating',
      );
    const d = quote(roles.delegated);
    // Preserve exact predecessor definitions for a controlled disposable rollback.
    for (const fn of changed) {
      const [old] = (await r.query(
        `SELECT pg_get_functiondef($1::regprocedure) AS definition`,
        [`"authorization".${fn}()`],
      )) as { definition: string }[];
      await r.query(
        `COMMENT ON FUNCTION "authorization".${fn}() IS '${old.definition.replaceAll("'", "''")}'`,
      );
    }
    await r.query(`ALTER TABLE "authorization".operation ALTER CONSTRAINT operation_tenant_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
      ALTER TABLE memberships.membership ADD CONSTRAINT uq_membership_tenant_id_identity UNIQUE(tenant_id,id,user_identity_id);
      ALTER TABLE "authorization".operation ADD COLUMN actor_membership_id uuid, ADD COLUMN actor_user_identity_id uuid;
      ALTER TABLE "authorization".audit_event ADD COLUMN actor_membership_id uuid, ADD COLUMN actor_user_identity_id uuid;
      ALTER TABLE "authorization".operation DROP CONSTRAINT operation_actor_type_check, DROP CONSTRAINT operation_operation_type_check;
      ALTER TABLE "authorization".operation ADD CONSTRAINT operation_actor_type_check CHECK(actor_type IN ('SYSTEM','INNOVIEW_OPERATOR','USER_IDENTITY')) NOT VALID;
      ALTER TABLE "authorization".operation ADD CONSTRAINT operation_operation_type_check CHECK(operation_type IN ('CREATE_ROLE','SET_ROLE','GRANT_PERMISSION','REVOKE_PERMISSION','ASSIGN','REVOKE_ASSIGNMENT','DELEGATED_ASSIGN','GRANT_TENANT_ADMIN')) NOT VALID;`);
    for (const table of ['operation', 'audit_event']) {
      await r.query(`ALTER TABLE "authorization".${table} ADD CONSTRAINT ${table}_human_actor CHECK(
        (actor_type='USER_IDENTITY' AND actor_membership_id IS NOT NULL AND actor_user_identity_id IS NOT NULL AND actor=actor_user_identity_id::text)
        OR (actor_type IN ('SYSTEM','INNOVIEW_OPERATOR') AND actor_membership_id IS NULL AND actor_user_identity_id IS NULL)) NOT VALID;
        ALTER TABLE "authorization".${table} ADD CONSTRAINT ${table}_human_membership FOREIGN KEY(tenant_id,actor_membership_id,actor_user_identity_id)
        REFERENCES memberships.membership(tenant_id,id,user_identity_id) ON DELETE RESTRICT NOT VALID;
        ALTER TABLE "authorization".${table} VALIDATE CONSTRAINT ${table}_human_actor;
        ALTER TABLE "authorization".${table} VALIDATE CONSTRAINT ${table}_human_membership`);
    }
    await r.query(`ALTER TABLE "authorization".operation VALIDATE CONSTRAINT operation_actor_type_check;
      ALTER TABLE "authorization".operation VALIDATE CONSTRAINT operation_operation_type_check;
      ALTER TABLE "authorization".operation ADD CONSTRAINT operation_delegated_type CHECK((operation_type='DELEGATED_ASSIGN')=(actor_type='USER_IDENTITY') AND (operation_type<>'GRANT_TENANT_ADMIN' OR actor_type='INNOVIEW_OPERATOR')) NOT VALID;
      ALTER TABLE "authorization".operation VALIDATE CONSTRAINT operation_delegated_type;
      INSERT INTO "authorization".permission(id,code,owner_module,description) VALUES
      ('a0000000-0000-4000-8000-000000000011','authorization.role.define','authorization','Reserved technical role definition'),
      ('a0000000-0000-4000-8000-000000000012','authorization.role.compose','authorization','Reserved technical role composition'),
      ('a0000000-0000-4000-8000-000000000013','authorization.assignment.grant','authorization','Exact-scope contained assignment'),
      ('a0000000-0000-4000-8000-000000000014','authorization.assignment.revoke','authorization','Reserved; no delegated revoke path'),
      ('a0000000-0000-4000-8000-000000000015','authorization.delegation.grant','authorization','Reserved Innoview delegation bootstrap') ON CONFLICT(code) DO NOTHING;`);

    // Identity's existing app append/read behavior is preserved. Delegation sees
    // only the verified issuer/subject candidate, and never timestamps or other users.
    await r.query(`ALTER TABLE identity.user_identity ENABLE ROW LEVEL SECURITY; ALTER TABLE identity.user_identity FORCE ROW LEVEL SECURITY;
      CREATE POLICY identity_existing_app ON identity.user_identity FOR ALL TO ${quote(roles.app)},${quote(roles.migrator)} USING(true) WITH CHECK(true);
      CREATE POLICY delegation_identity_boundary ON identity.user_identity AS RESTRICTIVE FOR ALL TO ${d}
        USING(issuer=current_setting('innoview.oidc_issuer',true) AND external_subject=current_setting('innoview.oidc_subject',true)) WITH CHECK(false);
      CREATE POLICY delegation_identity_select ON identity.user_identity FOR SELECT TO ${d}
        USING(issuer=current_setting('innoview.oidc_issuer',true) AND external_subject=current_setting('innoview.oidc_subject',true));`);
    const tenant = `tenant_id=(${uuid('tenant_id')})`;
    const replayBoundary = `(${tenant}) OR (request_id=(${uuid('authorization_request')}) AND completed_at IS NOT NULL)`;
    await r.query(`ALTER POLICY operator_boundary ON "authorization".operation USING(${replayBoundary});
      ALTER POLICY operator_select ON "authorization".operation USING(${replayBoundary});`);

    const member = `${tenant} AND (user_identity_id=(${uuid('user_identity_id')}) OR id=(${uuid('delegation_target_membership')}))`;
    await r.query(`CREATE POLICY delegation_boundary ON memberships.membership AS RESTRICTIVE FOR ALL TO ${d} USING(${member}) WITH CHECK(false);
      CREATE POLICY delegation_select ON memberships.membership FOR SELECT TO ${d} USING(${member});`);
    for (const table of [
      'tenant',
      'business_group',
      'organizational_unit',
      'company',
      'branch',
    ]) {
      const boundary = `${table === 'tenant' ? 'id' : 'tenant_id'}=(${uuid('tenant_id')})`;
      await r.query(`CREATE POLICY delegation_boundary ON organizations.${table} AS RESTRICTIVE FOR ALL TO ${d} USING(${boundary}) WITH CHECK(false);
        CREATE POLICY delegation_select ON organizations.${table} FOR SELECT TO ${d} USING(${boundary})`);
    }
    for (const table of scoped) {
      const boundary =
        table === 'operation'
          ? `(${tenant}) AND request_id=(${uuid('authorization_request')})`
          : table === 'audit_event'
            ? `(${tenant}) AND operation_request_id=(${uuid('authorization_request')})`
            : tenant;
      await r.query(
        `CREATE POLICY delegation_boundary ON "authorization".${table} AS RESTRICTIVE FOR ALL TO ${d} USING(${boundary}) WITH CHECK(${boundary})`,
      );
      if (table !== 'audit_event')
        await r.query(
          `CREATE POLICY delegation_select ON "authorization".${table} FOR SELECT TO ${d} USING(${boundary})`,
        );
      if (['role_assignment', 'operation', 'audit_event'].includes(table))
        await r.query(
          `CREATE POLICY delegation_insert ON "authorization".${table} FOR INSERT TO ${d} WITH CHECK(${boundary})`,
        );
      if (['operation', 'tenant_revision'].includes(table))
        await r.query(
          `CREATE POLICY delegation_update ON "authorization".${table} FOR UPDATE TO ${d} USING(${boundary}) WITH CHECK(${boundary})`,
        );
    }
    await r.query(`CREATE OR REPLACE FUNCTION "authorization".require_operation() RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE value text; operation_uuid uuid; marker text;
      BEGIN
        SELECT shobj_description(oid,'pg_authid') INTO marker FROM pg_roles WHERE rolname=current_user;
        IF marker IS NULL OR marker NOT IN ('innoview:'||current_database()||':authorization','innoview:'||current_database()||':authorization_delegation') THEN RAISE EXCEPTION 'Operator required' USING ERRCODE='42501'; END IF;
        value=current_setting('innoview.authorization_request',true);
        IF value IS NULL OR value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Canonical request required' USING ERRCODE='42501'; END IF;
        operation_uuid=value::uuid;
        IF NOT EXISTS(SELECT 1 FROM "authorization".operation o WHERE o.request_id=operation_uuid AND o.completed_at IS NULL
          AND o.actor=current_setting('innoview.authorization_actor',true) AND o.reason=current_setting('innoview.authorization_reason',true)
          AND o.actor_type=current_setting('innoview.authorization_actor_type',true)
          AND (o.actor_type<>'USER_IDENTITY' OR (o.actor_membership_id=(${uuid('delegation_actor_membership')}) AND o.actor_user_identity_id=(${uuid('user_identity_id')}))))
        THEN RAISE EXCEPTION 'Pending operation required' USING ERRCODE='42501'; END IF;
        RETURN operation_uuid;
      END $$;
      CREATE OR REPLACE FUNCTION "authorization".guard_operation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE value text; marker text; delegated boolean;
      BEGIN
        SELECT shobj_description(oid,'pg_authid') INTO marker FROM pg_roles WHERE rolname=current_user;
        delegated=marker='innoview:'||current_database()||':authorization_delegation';
        IF TG_OP='DELETE' OR marker IS NULL OR marker NOT IN ('innoview:'||current_database()||':authorization','innoview:'||current_database()||':authorization_delegation')
          OR delegated IS DISTINCT FROM (NEW.operation_type='DELEGATED_ASSIGN' AND NEW.actor_type='USER_IDENTITY')
          OR (NEW.operation_type='GRANT_TENANT_ADMIN' AND (delegated OR NEW.actor_type<>'INNOVIEW_OPERATOR'))
        THEN RAISE EXCEPTION 'Protected operation history' USING ERRCODE='42501'; END IF;
        value=current_setting('innoview.authorization_request',true);
        IF value IS NULL OR value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Canonical request required' USING ERRCODE='42501'; END IF;
        IF NEW.request_id<>value::uuid OR NEW.actor IS DISTINCT FROM current_setting('innoview.authorization_actor',true)
          OR NEW.reason IS DISTINCT FROM current_setting('innoview.authorization_reason',true) OR NEW.actor_type IS DISTINCT FROM current_setting('innoview.authorization_actor_type',true)
          OR (delegated AND (NEW.actor_membership_id IS DISTINCT FROM (${uuid('delegation_actor_membership')}) OR NEW.actor_user_identity_id IS DISTINCT FROM (${uuid('user_identity_id')})))
          OR (TG_OP='UPDATE' AND (OLD.completed_at IS NOT NULL OR (to_jsonb(NEW)-ARRAY['result','completed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result','completed_at'])))
          OR (TG_OP='INSERT' AND (NEW.result IS NOT NULL OR NEW.completed_at IS NOT NULL))
        THEN RAISE EXCEPTION 'Operation context mismatch' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION "authorization".guard_revision() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF TG_OP='INSERT' THEN
          IF NEW.revision<>0 OR NEW.tenant_id IS DISTINCT FROM (${uuid('tenant_id')}) OR (${uuid('authorization_request')}) IS NULL
            OR (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':authorization'
          THEN RAISE EXCEPTION 'Technical revision initialization required' USING ERRCODE='42501'; END IF;
        ELSE
          PERFORM "authorization".require_operation();
          IF TG_OP='DELETE' OR pg_trigger_depth()<>2 OR NEW.tenant_id<>OLD.tenant_id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Derived revision required' USING ERRCODE='42501'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION "authorization".guard_audit() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE o "authorization".operation%ROWTYPE;
      BEGIN
        IF TG_OP<>'INSERT' OR pg_trigger_depth()<>2 OR NEW.operation_request_id<>"authorization".require_operation() THEN RAISE EXCEPTION 'Derived immutable audit required' USING ERRCODE='42501'; END IF;
        SELECT * INTO STRICT o FROM "authorization".operation WHERE request_id=NEW.operation_request_id;
        NEW.actor_membership_id=o.actor_membership_id; NEW.actor_user_identity_id=o.actor_user_identity_id;
        RETURN NEW;
      END $$;`);
    const units = authorizationUnitsSql(true);
    const membership = authorizationMembershipSql();
    await r.query(`CREATE FUNCTION "authorization".delegation_allowed(uuid,uuid,uuid,uuid,text,uuid,uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
      WITH actor AS (${membership}), units AS (${units}), grants AS MATERIALIZED (
        SELECT DISTINCT p.id,p.code FROM "authorization".role_assignment a
        JOIN "authorization".role r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.status='ACTIVE'
        JOIN "authorization".role_permission rp ON rp.tenant_id=r.tenant_id AND rp.role_id=r.id AND rp.status='ACTIVE'
        JOIN "authorization".permission p ON p.id=rp.permission_id AND p.status='ACTIVE'
        WHERE a.tenant_id=$1 AND a.membership_id=$2 AND a.scope_type=$5 AND a.scope_unit_id=$6 AND a.status='ACTIVE')
      SELECT EXISTS(SELECT 1 FROM actor) AND EXISTS(SELECT 1 FROM units)
        AND EXISTS(SELECT 1 FROM memberships.membership WHERE tenant_id=$1 AND id=$7 AND status='ACTIVE')
        AND EXISTS(SELECT 1 FROM "authorization".role WHERE tenant_id=$1 AND id=$4 AND status='ACTIVE')
        AND EXISTS(SELECT 1 FROM grants WHERE code='authorization.assignment.grant')
        AND NOT EXISTS(SELECT 1 FROM "authorization".role_permission rp JOIN "authorization".permission p ON p.id=rp.permission_id
          WHERE rp.tenant_id=$1 AND rp.role_id=$4 AND p.owner_module='authorization')
        AND NOT EXISTS(SELECT 1 FROM "authorization".role_permission rp JOIN "authorization".permission p ON p.id=rp.permission_id
          WHERE rp.tenant_id=$1 AND rp.role_id=$4 AND rp.status='ACTIVE' AND p.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM grants WHERE grants.id=p.id))
      $$;
      CREATE FUNCTION "authorization".require_delegated_authority() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE request_uuid uuid; o "authorization".operation%ROWTYPE;
      BEGIN
        IF (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':authorization_delegation' THEN
          IF TG_WHEN='BEFORE' AND EXISTS(SELECT 1 FROM "authorization".role_permission rp JOIN "authorization".permission p ON p.id=rp.permission_id WHERE rp.tenant_id=NEW.tenant_id AND rp.role_id=NEW.role_id AND p.owner_module='authorization') THEN
            request_uuid="authorization".require_operation();
            IF NOT EXISTS(SELECT 1 FROM "authorization".operation WHERE request_id=request_uuid AND operation_type='GRANT_TENANT_ADMIN' AND actor_type='INNOVIEW_OPERATOR') THEN RAISE EXCEPTION 'Explicit Innoview bootstrap required' USING ERRCODE='42501'; END IF;
          END IF;
          RETURN NEW;
        END IF;
        request_uuid=(${uuid('authorization_request')});
        IF request_uuid IS NULL THEN RAISE EXCEPTION 'Delegated operation required' USING ERRCODE='42501'; END IF;
        SELECT * INTO o FROM "authorization".operation WHERE request_id=request_uuid AND tenant_id=NEW.tenant_id;
        IF o.request_id IS NULL OR o.operation_type<>'DELEGATED_ASSIGN' OR o.actor_type<>'USER_IDENTITY'
          OR o.actor_membership_id IS DISTINCT FROM (${uuid('delegation_actor_membership')}) OR o.actor_user_identity_id IS DISTINCT FROM (${uuid('user_identity_id')})
          OR o.actor IS DISTINCT FROM current_setting('innoview.authorization_actor',true) OR o.reason IS DISTINCT FROM current_setting('innoview.authorization_reason',true)
          OR NEW.status<>'ACTIVE' OR NOT "authorization".delegation_allowed(NEW.tenant_id,o.actor_membership_id,o.actor_user_identity_id,NEW.role_id,NEW.scope_type,NEW.scope_unit_id,NEW.membership_id)
        THEN RAISE EXCEPTION 'Delegated authority rejected' USING ERRCODE='42501'; END IF;
        IF TG_WHEN='BEFORE' AND o.completed_at IS NOT NULL THEN RAISE EXCEPTION 'Pending operation required' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER delegated_authority BEFORE INSERT ON "authorization".role_assignment FOR EACH ROW EXECUTE FUNCTION "authorization".require_delegated_authority();
      CREATE CONSTRAINT TRIGGER delegated_authority_commit AFTER INSERT ON "authorization".role_assignment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "authorization".require_delegated_authority();
      REVOKE ALL ON FUNCTION "authorization".delegation_allowed(uuid,uuid,uuid,uuid,text,uuid,uuid),"authorization".require_delegated_authority() FROM PUBLIC;`);
    await grantDelegation(r, roles.delegated);
  }
  async down(r: QueryRunner): Promise<void> {
    // Refuse to erase human provenance. Full reset is for empty disposable DBs.
    await r.query(
      'ALTER TABLE "authorization".operation NO FORCE ROW LEVEL SECURITY',
    );
    const [history] = (await r.query(
      `SELECT count(*)::int AS n FROM "authorization".operation WHERE operation_type IN ('DELEGATED_ASSIGN','GRANT_TENANT_ADMIN')`,
    )) as { n: number }[];
    if (history.n)
      throw new Error(
        'Delegation history requires a forward migration; rollback refused',
      );
    await r.query(
      'ALTER TABLE "authorization".operation FORCE ROW LEVEL SECURITY',
    );
    await r.query(`DROP TRIGGER delegated_authority ON "authorization".role_assignment; DROP TRIGGER delegated_authority_commit ON "authorization".role_assignment;
      DROP FUNCTION "authorization".require_delegated_authority(); DROP FUNCTION "authorization".delegation_allowed(uuid,uuid,uuid,uuid,text,uuid,uuid);`);
    for (const fn of changed) {
      const [old] = (await r.query(
        `SELECT obj_description($1::regprocedure,'pg_proc') AS definition`,
        [`"authorization".${fn}()`],
      )) as { definition: string }[];
      if (!old.definition?.startsWith('CREATE OR REPLACE FUNCTION'))
        throw new Error('Rollback metadata missing');
      await r.query(old.definition);
      await r.query(`COMMENT ON FUNCTION "authorization".${fn}() IS NULL`);
    }
    await r.query(
      `ALTER POLICY operator_boundary ON "authorization".operation USING(tenant_id=(${uuid('tenant_id')})); ALTER POLICY operator_select ON "authorization".operation USING(tenant_id=(${uuid('tenant_id')}));`,
    );
    for (const table of scoped)
      for (const policy of [
        'delegation_boundary',
        'delegation_select',
        'delegation_insert',
        'delegation_update',
      ])
        await r.query(
          `DROP POLICY IF EXISTS ${policy} ON "authorization".${table}`,
        );
    for (const table of [
      'tenant',
      'business_group',
      'organizational_unit',
      'company',
      'branch',
    ])
      await r.query(
        `DROP POLICY delegation_boundary ON organizations.${table}; DROP POLICY delegation_select ON organizations.${table}`,
      );
    await r.query(`DROP POLICY delegation_boundary ON memberships.membership; DROP POLICY delegation_select ON memberships.membership;
      DROP POLICY identity_existing_app ON identity.user_identity; DROP POLICY delegation_identity_boundary ON identity.user_identity; DROP POLICY delegation_identity_select ON identity.user_identity;
      ALTER TABLE identity.user_identity DISABLE ROW LEVEL SECURITY; ALTER TABLE identity.user_identity NO FORCE ROW LEVEL SECURITY;`);
    for (const table of ['operation', 'audit_event'])
      await r.query(
        `ALTER TABLE "authorization".${table} DROP CONSTRAINT ${table}_human_membership, DROP CONSTRAINT ${table}_human_actor, DROP COLUMN actor_membership_id, DROP COLUMN actor_user_identity_id`,
      );
    await r.query(`ALTER TABLE memberships.membership DROP CONSTRAINT uq_membership_tenant_id_identity;
      ALTER TABLE "authorization".operation DROP CONSTRAINT operation_delegated_type, DROP CONSTRAINT operation_actor_type_check, DROP CONSTRAINT operation_operation_type_check;
      ALTER TABLE "authorization".operation ADD CHECK(actor_type IN ('SYSTEM','INNOVIEW_OPERATOR')), ADD CHECK(operation_type IN ('CREATE_ROLE','SET_ROLE','GRANT_PERMISSION','REVOKE_PERMISSION','ASSIGN','REVOKE_ASSIGNMENT'));`);
    await r.query(
      'ALTER TABLE "authorization".operation ALTER CONSTRAINT operation_tenant_id_fkey NOT DEFERRABLE',
    );
    // Catalog is append-only even on rollback: codes remain reserved, ungranted.
  }
}

// Frozen migration ACLs; provisioning reconciles the current contract separately.
async function grantDelegation(
  r: { query(sql: string): Promise<unknown> },
  role: string,
) {
  const d = quote(role);
  await r.query(`GRANT USAGE ON SCHEMA identity,memberships,organizations,"authorization" TO ${d};
    GRANT SELECT(id,issuer,external_subject) ON identity.user_identity TO ${d};
    GRANT SELECT(id,tenant_id,user_identity_id,status) ON memberships.membership TO ${d};
    GRANT SELECT(id,status) ON organizations.tenant TO ${d};
    GRANT SELECT(id,tenant_id) ON organizations.business_group TO ${d};
    GRANT SELECT(id,tenant_id,type,status) ON organizations.organizational_unit TO ${d};
    GRANT SELECT(id,tenant_id,business_group_id) ON organizations.company TO ${d};
    GRANT SELECT(id,tenant_id,company_id) ON organizations.branch TO ${d};
    GRANT SELECT ON "authorization".permission,"authorization".catalog_version,"authorization".role,"authorization".role_permission,"authorization".role_assignment,"authorization".tenant_revision,"authorization".operation TO ${d};
    GRANT INSERT(tenant_id,membership_id,role_id,scope_type,scope_unit_id) ON "authorization".role_assignment TO ${d};
    GRANT INSERT(request_id,tenant_id,operation_type,fingerprint,fingerprint_version,actor,actor_type,reason,technical_source,actor_membership_id,actor_user_identity_id) ON "authorization".operation TO ${d};
    GRANT INSERT(tenant_id,operation_request_id,record_type,record_id,action,old_status,new_status,actor,actor_type,reason,technical_source,db_actor) ON "authorization".audit_event TO ${d};
    GRANT UPDATE(result,completed_at) ON "authorization".operation TO ${d};
    GRANT UPDATE(revision) ON "authorization".tenant_revision TO ${d};
    GRANT EXECUTE ON FUNCTION "authorization".require_operation(),"authorization".delegation_allowed(uuid,uuid,uuid,uuid,text,uuid,uuid) TO ${d};`);
}
