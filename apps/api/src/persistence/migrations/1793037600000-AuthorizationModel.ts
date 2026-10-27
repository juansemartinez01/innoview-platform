import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AuthorizationModel1793037600000 implements MigrationInterface {
  name = 'AuthorizationModel1793037600000';
  async up(r: QueryRunner): Promise<void> {
    await r.query(`CREATE TABLE "authorization".catalog_version(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0));
      INSERT INTO "authorization".catalog_version VALUES(true,0);
      CREATE TABLE "authorization".permission(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code varchar(160) NOT NULL UNIQUE,
        owner_module varchar(60) NOT NULL,description varchar(500) NOT NULL,
        status varchar(10) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DEPRECATED')),
        replaced_by uuid REFERENCES "authorization".permission(id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK(code ~ '^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*[.][a-z][a-z0-9_]*$'),
        CHECK(owner_module=split_part(code,'.',1)),CHECK(replaced_by IS DISTINCT FROM id));
      CREATE TABLE "authorization".role(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES organizations.tenant(id) ON DELETE RESTRICT,
        name varchar(120) NOT NULL CHECK(length(btrim(name))>0 AND name=btrim(name)),description varchar(500) NOT NULL DEFAULT '',
        status varchar(8) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_role_tenant_id UNIQUE(tenant_id,id),CONSTRAINT uq_role_tenant_name UNIQUE(tenant_id,name));
      CREATE TABLE "authorization".role_permission(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,role_id uuid NOT NULL,
        permission_id uuid NOT NULL REFERENCES "authorization".permission(id) ON DELETE RESTRICT,
        status varchar(7) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        revoked_at timestamptz,revocation_reason text,
        FOREIGN KEY(tenant_id,role_id) REFERENCES "authorization".role(tenant_id,id) ON DELETE RESTRICT,
        CHECK((status='ACTIVE' AND revoked_at IS NULL AND revocation_reason IS NULL) OR (status='REVOKED' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)));
      CREATE UNIQUE INDEX uq_active_role_permission ON "authorization".role_permission(tenant_id,role_id,permission_id) WHERE status='ACTIVE';
      CREATE TABLE "authorization".role_assignment(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,membership_id uuid NOT NULL,role_id uuid NOT NULL,
        scope_unit_id uuid NOT NULL,scope_type varchar(7) NOT NULL CHECK(scope_type IN ('GROUP','COMPANY','BRANCH')),
        status varchar(7) NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOKED')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),revoked_at timestamptz,revocation_reason text,
        FOREIGN KEY(tenant_id,membership_id) REFERENCES memberships.membership(tenant_id,id) ON DELETE RESTRICT,
        FOREIGN KEY(tenant_id,role_id) REFERENCES "authorization".role(tenant_id,id) ON DELETE RESTRICT,
        FOREIGN KEY(tenant_id,scope_unit_id,scope_type) REFERENCES organizations.organizational_unit(tenant_id,id,type) ON DELETE RESTRICT,
        CHECK((status='ACTIVE' AND revoked_at IS NULL AND revocation_reason IS NULL) OR (status='REVOKED' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)));
      CREATE UNIQUE INDEX uq_active_role_assignment ON "authorization".role_assignment(tenant_id,membership_id,role_id,scope_unit_id,scope_type) WHERE status='ACTIVE';
        CREATE INDEX assignment_member_scope ON "authorization".role_assignment(tenant_id,membership_id,scope_type,scope_unit_id,role_id) WHERE status='ACTIVE';
        CREATE INDEX assignment_tenant ON "authorization".role_assignment(tenant_id,id);
      CREATE TABLE "authorization".tenant_revision(tenant_id uuid PRIMARY KEY REFERENCES organizations.tenant(id) ON DELETE RESTRICT,revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0));
      CREATE TABLE "authorization".operation(
        request_id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES organizations.tenant(id) ON DELETE RESTRICT,
        operation_type text NOT NULL CHECK(operation_type IN ('CREATE_ROLE','SET_ROLE','GRANT_PERMISSION','REVOKE_PERMISSION','ASSIGN','REVOKE_ASSIGNMENT')),
        fingerprint char(64) NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),fingerprint_version smallint NOT NULL CHECK(fingerprint_version=2),
        actor varchar(200) NOT NULL CHECK(length(btrim(actor))>0),actor_type text NOT NULL CHECK(actor_type IN ('SYSTEM','INNOVIEW_OPERATOR')),
        reason varchar(500) NOT NULL CHECK(length(btrim(reason))>0),technical_source text NOT NULL,
        result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
        UNIQUE(tenant_id,request_id));
      CREATE TABLE "authorization".audit_event(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,operation_request_id uuid NOT NULL,
        record_type text NOT NULL CHECK(record_type IN ('role','role_permission','role_assignment')),record_id uuid NOT NULL,
        action text NOT NULL CHECK(action IN ('INSERT','UPDATE','REVOKED')),old_status text,new_status text,
        actor text NOT NULL,actor_type text NOT NULL,reason text NOT NULL,technical_source text NOT NULL,db_actor text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY(tenant_id,operation_request_id) REFERENCES "authorization".operation(tenant_id,request_id) ON DELETE RESTRICT);
      CREATE INDEX authorization_audit_operation ON "authorization".audit_event(tenant_id,operation_request_id)`);
    await r.query(`CREATE FUNCTION "authorization".guard_catalog() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF TG_OP='DELETE' OR (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':migrator'
        THEN RAISE EXCEPTION 'Migrator-only catalog' USING ERRCODE='42501'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(current_database()||':"authorization".catalog',0));
        IF TG_OP='UPDATE' THEN
          IF NEW.id<>OLD.id OR NEW.code<>OLD.code OR NEW.owner_module<>OLD.owner_module OR (OLD.status='DEPRECATED' AND NEW.status<>'DEPRECATED')
          THEN RAISE EXCEPTION 'Immutable permission identity or terminal deprecation' USING ERRCODE='23514'; END IF;
          IF ROW(NEW.description,NEW.status,NEW.replaced_by) IS NOT DISTINCT FROM ROW(OLD.description,OLD.status,OLD.replaced_by) THEN RETURN OLD; END IF;
          NEW.updated_at=clock_timestamp();
        END IF;
        RETURN NEW;
      END $$;
      CREATE FUNCTION "authorization".bump_catalog() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF TG_OP='INSERT' OR NEW IS DISTINCT FROM OLD THEN UPDATE "authorization".catalog_version SET revision=revision+1 WHERE singleton; END IF;
        RETURN NEW;
      END $$;
      CREATE FUNCTION "authorization".guard_catalog_version() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF TG_OP<>'UPDATE' OR pg_trigger_depth()<>2 OR NEW.revision<>OLD.revision+1 OR NEW.singleton IS DISTINCT FROM OLD.singleton
        THEN RAISE EXCEPTION 'Catalog version is derived' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER catalog_guard BEFORE INSERT OR UPDATE OR DELETE ON "authorization".permission FOR EACH ROW EXECUTE FUNCTION "authorization".guard_catalog();
      CREATE TRIGGER catalog_bump AFTER INSERT OR UPDATE ON "authorization".permission FOR EACH ROW EXECUTE FUNCTION "authorization".bump_catalog();
      CREATE TRIGGER catalog_version_guard BEFORE INSERT OR UPDATE OR DELETE ON "authorization".catalog_version FOR EACH ROW EXECUTE FUNCTION "authorization".guard_catalog_version();
      INSERT INTO "authorization".permission(id,code,owner_module,description) VALUES
       ('a0000000-0000-4000-8000-000000000001','foundation.probe.read','foundation','Technical Foundation probe, no commercial capability'),
       ('a0000000-0000-4000-8000-000000000002','foundation.probe.write','foundation','Technical Foundation probe, no commercial capability')`);
    await r.query(`CREATE FUNCTION "authorization".require_operation() RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE value text; operation_uuid uuid;
      BEGIN
        IF (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':authorization'
        THEN RAISE EXCEPTION 'Authorization operator required' USING ERRCODE='42501'; END IF;
        value=current_setting('innoview.authorization_request',true);
        IF value IS NULL OR value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN RAISE EXCEPTION 'Canonical operation required' USING ERRCODE='42501'; END IF;
        operation_uuid=value::uuid;
        IF NOT EXISTS(SELECT 1 FROM "authorization".operation o WHERE o.request_id=operation_uuid AND o.completed_at IS NULL
          AND o.actor=current_setting('innoview.authorization_actor',true) AND o.reason=current_setting('innoview.authorization_reason',true)
          AND o.actor_type=current_setting('innoview.authorization_actor_type',true))
        THEN RAISE EXCEPTION 'Pending trusted operation required' USING ERRCODE='42501'; END IF;
        RETURN operation_uuid;
      END $$;
      CREATE FUNCTION "authorization".guard_operation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE op text;
      BEGIN
        IF TG_OP='DELETE' OR (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':authorization'
        THEN RAISE EXCEPTION 'Protected operation history' USING ERRCODE='42501'; END IF;
        op=current_setting('innoview.authorization_request',true);
        IF op IS NULL OR op !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN RAISE EXCEPTION 'Canonical request required' USING ERRCODE='42501'; END IF;
        IF NEW.request_id<>op::uuid OR NEW.actor IS DISTINCT FROM current_setting('innoview.authorization_actor',true)
          OR NEW.reason IS DISTINCT FROM current_setting('innoview.authorization_reason',true) OR NEW.actor_type IS DISTINCT FROM current_setting('innoview.authorization_actor_type',true)
          OR (TG_OP='UPDATE' AND (OLD.completed_at IS NOT NULL OR OLD.request_id<>op::uuid))
          OR (TG_OP='INSERT' AND (NEW.result IS NOT NULL OR NEW.completed_at IS NOT NULL))
        THEN RAISE EXCEPTION 'Operation context mismatch' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$;
      CREATE FUNCTION "authorization".assert_operation_complete() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM "authorization".operation WHERE request_id=NEW.request_id AND (result IS NULL OR completed_at IS NULL))
        THEN RAISE EXCEPTION 'Operation must complete atomically' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END $$;
      CREATE TRIGGER operation_guard BEFORE INSERT OR UPDATE OR DELETE ON "authorization".operation FOR EACH ROW EXECUTE FUNCTION "authorization".guard_operation();
      CREATE CONSTRAINT TRIGGER operation_complete AFTER INSERT OR UPDATE ON "authorization".operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "authorization".assert_operation_complete()`);
    await r.query(`CREATE FUNCTION "authorization".guard_domain() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        PERFORM "authorization".require_operation();
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'History cannot be deleted' USING ERRCODE='42501'; END IF;
        IF TG_OP='UPDATE' THEN
          IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id THEN RAISE EXCEPTION 'Immutable reference' USING ERRCODE='23514'; END IF;
          IF TG_TABLE_NAME<>'role' THEN
            IF NEW.role_id<>OLD.role_id OR (to_jsonb(NEW)-ARRAY['status','updated_at','revoked_at','revocation_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','updated_at','revoked_at','revocation_reason'])
              OR (OLD.status='REVOKED' AND NEW.status<>'REVOKED') THEN RAISE EXCEPTION 'Immutable grant or terminal revocation' USING ERRCODE='23514'; END IF;
          END IF;
          IF (to_jsonb(NEW)-'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN RETURN OLD; END IF;
          NEW.updated_at=clock_timestamp();
          IF TG_TABLE_NAME<>'role' AND NEW.status='REVOKED' AND OLD.status<>'REVOKED' THEN NEW.revoked_at=clock_timestamp();NEW.revocation_reason=current_setting('innoview.authorization_reason'); END IF;
        ELSE
          IF TG_TABLE_NAME<>'role' AND NEW.status<>'ACTIVE' THEN RAISE EXCEPTION 'New grants must be active' USING ERRCODE='23514'; END IF;
          IF TG_TABLE_NAME='role_permission' THEN
            PERFORM pg_advisory_xact_lock_shared(hashtextextended(current_database()||':"authorization".catalog',0));
            IF NOT EXISTS(SELECT 1 FROM "authorization".permission WHERE id=NEW.permission_id AND status='ACTIVE') THEN RAISE EXCEPTION 'Active permission required' USING ERRCODE='23514'; END IF;
          ELSIF TG_TABLE_NAME='role_assignment' THEN
            IF NOT EXISTS(SELECT 1 FROM "authorization".role WHERE tenant_id=NEW.tenant_id AND id=NEW.role_id AND status='ACTIVE') THEN RAISE EXCEPTION 'Active role required' USING ERRCODE='23514'; END IF;
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE FUNCTION "authorization".guard_revision() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        PERFORM "authorization".require_operation();
        IF TG_OP='DELETE' OR (TG_OP='INSERT' AND NEW.revision<>0) OR (TG_OP='UPDATE' AND (pg_trigger_depth()<>2 OR NEW.tenant_id<>OLD.tenant_id OR NEW.revision<>OLD.revision+1))
        THEN RAISE EXCEPTION 'Derived tenant revision required' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$;
      CREATE FUNCTION "authorization".audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE op uuid;
      BEGIN
        IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
        op="authorization".require_operation();
        UPDATE "authorization".tenant_revision SET revision=revision+1 WHERE tenant_id=NEW.tenant_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Tenant revision required' USING ERRCODE='23514'; END IF;
        INSERT INTO "authorization".audit_event(tenant_id,operation_request_id,record_type,record_id,action,old_status,new_status,actor,actor_type,reason,technical_source,db_actor)
          SELECT NEW.tenant_id,op,TG_TABLE_NAME,NEW.id,CASE WHEN TG_OP='INSERT' THEN 'INSERT' WHEN NEW.status='REVOKED' THEN 'REVOKED' ELSE 'UPDATE' END,
            CASE WHEN TG_OP='UPDATE' THEN OLD.status ELSE NULL END,NEW.status,o.actor,o.actor_type,o.reason,o.technical_source,current_user
          FROM "authorization".operation o WHERE o.request_id=op;
        RETURN NEW;
      END $$;
      CREATE FUNCTION "authorization".guard_audit() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF TG_OP<>'INSERT' OR pg_trigger_depth()<>2 OR NEW.operation_request_id<>"authorization".require_operation()
        THEN RAISE EXCEPTION 'Derived immutable audit required' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER revision_guard BEFORE INSERT OR UPDATE OR DELETE ON "authorization".tenant_revision FOR EACH ROW EXECUTE FUNCTION "authorization".guard_revision();
      CREATE TRIGGER audit_guard BEFORE INSERT OR UPDATE OR DELETE ON "authorization".audit_event FOR EACH ROW EXECUTE FUNCTION "authorization".guard_audit()`);
    for (const table of ['role', 'role_permission', 'role_assignment']) {
      await r.query(
        `CREATE TRIGGER domain_guard BEFORE INSERT OR UPDATE OR DELETE ON "authorization".${table} FOR EACH ROW EXECUTE FUNCTION "authorization".guard_domain()`,
      );
      await r.query(
        `CREATE TRIGGER domain_audit AFTER INSERT OR UPDATE ON "authorization".${table} FOR EACH ROW EXECUTE FUNCTION "authorization".audit_change()`,
      );
    }
    const uuid =
      "CASE WHEN current_setting('innoview.tenant_id',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN current_setting('innoview.tenant_id',true)::uuid ELSE NULL::uuid END";
    const [roles] = (await r.query(
      "SELECT (SELECT rolname FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':app') AS app,(SELECT rolname FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':authorization') AS operator",
    )) as { app: string; operator: string }[];
    const quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';
    for (const table of [
      'role',
      'role_permission',
      'role_assignment',
      'tenant_revision',
      'operation',
      'audit_event',
    ]) {
      const boundary = `tenant_id=(${uuid})`;
      await r.query(
        `CREATE POLICY operator_boundary ON "authorization".${table} AS RESTRICTIVE FOR ALL TO ${quote(roles.operator)} USING(${boundary}) WITH CHECK(${boundary})`,
      );
      await r.query(
        `CREATE POLICY operator_select ON "authorization".${table} FOR SELECT TO ${quote(roles.operator)} USING(${boundary})`,
      );
      await r.query(
        `CREATE POLICY operator_insert ON "authorization".${table} FOR INSERT TO ${quote(roles.operator)} WITH CHECK(${boundary})`,
      );
      if (table !== 'audit_event')
        await r.query(
          `CREATE POLICY operator_update ON "authorization".${table} FOR UPDATE TO ${quote(roles.operator)} USING(${boundary}) WITH CHECK(${boundary})`,
        );
      if (!['operation', 'audit_event'].includes(table)) {
        const own =
          table === 'role_assignment'
            ? ` AND EXISTS(SELECT 1 FROM memberships.membership m WHERE m.tenant_id=role_assignment.tenant_id AND m.id=role_assignment.membership_id)`
            : '';
        const appBoundary = `${boundary} AND EXISTS(SELECT 1 FROM organizations.tenant_directory d WHERE d.tenant_id=${table}.tenant_id AND d.available)${own}`;
        await r.query(
          `CREATE POLICY app_boundary ON "authorization".${table} AS RESTRICTIVE FOR ALL TO ${quote(roles.app)} USING(${appBoundary}) WITH CHECK(false)`,
        );
        await r.query(
          `CREATE POLICY app_select ON "authorization".${table} FOR SELECT TO ${quote(roles.app)} USING(${appBoundary})`,
        );
      }
      await r.query(
        `ALTER TABLE "authorization".${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE "authorization".${table} FORCE ROW LEVEL SECURITY`,
      );
    }
    // Exact grants also needed on fresh installation before reconciliation.
    await r.query(`GRANT USAGE ON SCHEMA "authorization" TO ${quote(roles.app)},${quote(roles.operator)};
      GRANT SELECT ON "authorization".permission,"authorization".catalog_version TO ${quote(roles.app)},${quote(roles.operator)};
      GRANT SELECT ON "authorization".role,"authorization".role_permission,"authorization".role_assignment,"authorization".tenant_revision TO ${quote(roles.app)};
      GRANT SELECT,INSERT ON "authorization".role,"authorization".role_permission,"authorization".role_assignment,"authorization".tenant_revision,"authorization".operation,"authorization".audit_event TO ${quote(roles.operator)};
      GRANT UPDATE(name,description,status,updated_at) ON "authorization".role TO ${quote(roles.operator)};
      GRANT UPDATE(status,updated_at) ON "authorization".role_permission,"authorization".role_assignment TO ${quote(roles.operator)};
      GRANT UPDATE(revision) ON "authorization".tenant_revision TO ${quote(roles.operator)};
      GRANT UPDATE(result,completed_at) ON "authorization".operation TO ${quote(roles.operator)};
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "authorization" FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION "authorization".require_operation() TO ${quote(roles.operator)}`);
    // N-3: additive CHECK on the populated operation ledger, no PK/UNIQUE misuse.
    await r.query(
      'ALTER TABLE organizations.operation ADD CONSTRAINT organization_operation_technical_source CHECK(length(btrim(technical_source))>0) NOT VALID',
    );
    await r.query(
      'ALTER TABLE organizations.operation VALIDATE CONSTRAINT organization_operation_technical_source',
    );
  }
  async down(r: QueryRunner): Promise<void> {
    await r.query(
      'ALTER TABLE organizations.operation DROP CONSTRAINT organization_operation_technical_source',
    );
    for (const table of [
      'audit_event',
      'operation',
      'role_assignment',
      'role_permission',
      'role',
      'tenant_revision',
      'permission',
      'catalog_version',
    ])
      await r.query(`DROP TABLE "authorization".${table}`);
    for (const fn of [
      'guard_audit',
      'audit_change',
      'guard_revision',
      'guard_domain',
      'assert_operation_complete',
      'guard_operation',
      'require_operation',
      'guard_catalog_version',
      'bump_catalog',
      'guard_catalog',
    ])
      await r.query(`DROP FUNCTION "authorization".${fn}()`);
  }
}
