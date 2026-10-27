import type { MigrationInterface, QueryRunner } from 'typeorm';

const contextualUuid = (name: string) =>
  `CASE WHEN current_setting('innoview.${name}',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN current_setting('innoview.${name}',true)::uuid ELSE NULL::uuid END`;
export class DirectoryRepair1793134800000 implements MigrationInterface {
  name = 'DirectoryRepair1793134800000';
  async up(r: QueryRunner) {
    const [{ role }] = await r.manager.query<{ role: string }[]>(
      `SELECT quote_ident(rolname) AS role FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':directory_maintenance'`,
    );
    await r.query(`CREATE TABLE organizations.directory_repair_operation(
      request_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,actor_type text NOT NULL CHECK(actor_type IN ('SYSTEM','INNOVIEW_OPERATOR')),actor text NOT NULL CHECK(length(btrim(actor)) BETWEEN 1 AND 200),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
      fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),backup_sha256 text NOT NULL CHECK(backup_sha256 ~ '^[0-9a-f]{64}$'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,result jsonb,
      UNIQUE(tenant_id,request_id));
      CREATE TABLE organizations.directory_repair_event(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,request_id uuid NOT NULL,
      before_state jsonb,after_state jsonb,db_actor text NOT NULL DEFAULT current_user,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY(tenant_id,request_id) REFERENCES organizations.directory_repair_operation(tenant_id,request_id) ON DELETE RESTRICT);`);
    for (const table of [
      'directory_repair_operation',
      'directory_repair_event',
    ]) {
      const boundary = `tenant_id=${contextualUuid('tenant_id')}`;
      await r.query(`ALTER TABLE organizations.${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE organizations.${table} FORCE ROW LEVEL SECURITY;
        CREATE POLICY maintenance_boundary ON organizations.${table} AS RESTRICTIVE FOR ALL TO ${role} USING(${boundary}) WITH CHECK(${boundary});
        CREATE POLICY maintenance_select ON organizations.${table} FOR SELECT TO ${role} USING(${boundary});
        CREATE POLICY maintenance_insert ON organizations.${table} FOR INSERT TO ${role} WITH CHECK(${boundary});
        GRANT SELECT,INSERT ON organizations.${table} TO ${role};`);
      if (table === 'directory_repair_operation')
        await r.query(
          `CREATE POLICY maintenance_update ON organizations.${table} FOR UPDATE TO ${role} USING(${boundary}) WITH CHECK(${boundary}); GRANT UPDATE(result,completed_at) ON organizations.${table} TO ${role};`,
        );
    }
    const boundary = `tenant_id=${contextualUuid('tenant_id')}`;
    await r.query(`GRANT INSERT,UPDATE,DELETE ON organizations.tenant_directory TO ${role};
      CREATE POLICY maintenance_insert ON organizations.tenant_directory FOR INSERT TO ${role} WITH CHECK(${boundary});
      CREATE POLICY maintenance_update ON organizations.tenant_directory FOR UPDATE TO ${role} USING(${boundary}) WITH CHECK(${boundary});
      CREATE POLICY maintenance_delete ON organizations.tenant_directory FOR DELETE TO ${role} USING(${boundary});
      CREATE POLICY maintenance_insert_boundary ON organizations.tenant_directory AS RESTRICTIVE FOR INSERT TO ${role} WITH CHECK(${boundary});
      CREATE POLICY maintenance_update_boundary ON organizations.tenant_directory AS RESTRICTIVE FOR UPDATE TO ${role} USING(${boundary}) WITH CHECK(${boundary});
      CREATE POLICY maintenance_delete_boundary ON organizations.tenant_directory AS RESTRICTIVE FOR DELETE TO ${role} USING(${boundary});`);
    await r.query(`CREATE FUNCTION organizations.guard_directory_repair() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE request_text text; request_uuid uuid;
      BEGIN
        IF (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':directory_maintenance'
        THEN RAISE EXCEPTION 'Isolated maintenance required' USING ERRCODE='42501'; END IF;
        request_text=current_setting('innoview.directory_request',true);
        IF request_text IS NULL OR request_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Maintenance context required' USING ERRCODE='42501'; END IF;
        request_uuid=request_text::uuid;
        IF TG_TABLE_NAME='directory_repair_operation' THEN
          IF TG_OP='DELETE' OR NEW.request_id<>request_uuid OR NEW.actor IS DISTINCT FROM current_setting('innoview.directory_actor',true) OR NEW.reason IS DISTINCT FROM current_setting('innoview.directory_reason',true) OR NEW.actor_type IS DISTINCT FROM current_setting('innoview.directory_actor_type',true)
          THEN RAISE EXCEPTION 'Maintenance provenance mismatch' USING ERRCODE='42501'; END IF;
          IF TG_OP='INSERT' THEN
            IF NEW.result IS NOT NULL OR NEW.completed_at IS NOT NULL THEN RAISE EXCEPTION 'Pending maintenance required' USING ERRCODE='42501'; END IF;
          ELSIF OLD.completed_at IS NOT NULL OR (to_jsonb(NEW)-ARRAY['result','completed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['result','completed_at']) THEN RAISE EXCEPTION 'Maintenance history immutable' USING ERRCODE='42501'; END IF;
        ELSE
          IF TG_TABLE_NAME='directory_repair_event' AND (TG_OP<>'INSERT' OR pg_trigger_depth()<>2) THEN RAISE EXCEPTION 'Derived immutable repair audit' USING ERRCODE='42501'; END IF;
          IF NOT EXISTS(SELECT 1 FROM organizations.directory_repair_operation WHERE request_id=request_uuid AND completed_at IS NULL AND actor=current_setting('innoview.directory_actor',true) AND reason=current_setting('innoview.directory_reason',true)) THEN RAISE EXCEPTION 'Pending maintenance required' USING ERRCODE='42501'; END IF;
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
      END $$;
      CREATE TRIGGER repair_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON organizations.directory_repair_operation FOR EACH ROW EXECUTE FUNCTION organizations.guard_directory_repair();
      CREATE TRIGGER repair_event_guard BEFORE INSERT OR UPDATE OR DELETE ON organizations.directory_repair_event FOR EACH ROW EXECUTE FUNCTION organizations.guard_directory_repair();
      CREATE FUNCTION organizations.audit_directory_repair() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user)='innoview:'||current_database()||':directory_maintenance' THEN
          INSERT INTO organizations.directory_repair_event(tenant_id,request_id,before_state,after_state)
          VALUES(CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END,current_setting('innoview.directory_request')::uuid,CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END);
        END IF; RETURN NULL;
      END $$;
      CREATE TRIGGER repair_audit AFTER INSERT OR UPDATE OR DELETE ON organizations.tenant_directory FOR EACH ROW EXECUTE FUNCTION organizations.audit_directory_repair();
      CREATE FUNCTION organizations.assert_repair_complete() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM organizations.directory_repair_operation WHERE request_id=NEW.request_id AND (completed_at IS NULL OR result IS NULL)) THEN RAISE EXCEPTION 'Repair must complete atomically' USING ERRCODE='23514'; END IF; RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER repair_complete AFTER INSERT OR UPDATE ON organizations.directory_repair_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION organizations.assert_repair_complete();`);
    // Preserve the existing derived-write guard for normal operators. Add only
    // the isolated, pending-ledger maintenance path; no SECURITY DEFINER.
    const [{ definition }] = await r.manager.query<{ definition: string }[]>(
      `SELECT pg_get_functiondef('organizations.guard_derived_write()'::regprocedure) AS definition`,
    );
    await r.query(
      definition.replace(
        /BEGIN/i,
        () => `BEGIN
      IF TG_TABLE_NAME='tenant_directory' AND (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user)='innoview:'||current_database()||':directory_maintenance' THEN
        IF NOT EXISTS(SELECT 1 FROM organizations.directory_repair_operation WHERE request_id=${contextualUuid('directory_request')} AND completed_at IS NULL AND actor=current_setting('innoview.directory_actor',true) AND reason=current_setting('innoview.directory_reason',true)) THEN RAISE EXCEPTION 'Pending repair required' USING ERRCODE='42501'; END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
      END IF;`,
      ),
    );
    // Every source write and repair share a transaction-level gate per tenant.
    // READ COMMITTED repair takes the gate before its source comparison. An
    // ordinary writer cannot omit it by skipping the TypeScript service.
    await r.query(`CREATE FUNCTION organizations.lock_write_tenant() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('innoview:organization-write:'||CASE WHEN TG_TABLE_NAME='tenant' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'tenant_id' END,0));
        RETURN NEW;
      END $$`);
    for (const table of [
      'tenant',
      'organizational_unit',
      'business_group',
      'company',
      'branch',
    ])
      await r.query(
        `CREATE TRIGGER aa_organization_write_gate BEFORE INSERT OR UPDATE ON organizations.${table} FOR EACH ROW EXECUTE FUNCTION organizations.lock_write_tenant()`,
      );
    await r.query(
      'REVOKE ALL ON FUNCTION organizations.lock_write_tenant() FROM PUBLIC',
    );
    await r.query(
      'REVOKE ALL ON FUNCTION organizations.guard_directory_repair(),organizations.audit_directory_repair(),organizations.assert_repair_complete() FROM PUBLIC',
    );
  }
  async down(r: QueryRunner) {
    for (const table of [
      'tenant',
      'organizational_unit',
      'business_group',
      'company',
      'branch',
    ])
      await r.query(
        `DROP TRIGGER aa_organization_write_gate ON organizations.${table}`,
      );
    await r.query('DROP FUNCTION organizations.lock_write_tenant()');
    const [{ definition }] = await r.manager.query<{ definition: string }[]>(
      `SELECT pg_get_functiondef('organizations.guard_derived_write()'::regprocedure) AS definition`,
    );
    await r.query(
      definition.replace(
        /\n\s*IF TG_TABLE_NAME='tenant_directory'[\s\S]*?END IF;\s*IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;\s*END IF;/,
        '',
      ),
    );
    await r.query(
      'DROP TRIGGER repair_audit ON organizations.tenant_directory; DROP TABLE organizations.directory_repair_event,organizations.directory_repair_operation; DROP FUNCTION organizations.guard_directory_repair(),organizations.audit_directory_repair(),organizations.assert_repair_complete()',
    );
    const policies = await r.manager.query<{ policyname: string }[]>(
      `SELECT policyname FROM pg_policies WHERE schemaname='organizations' AND tablename='tenant_directory' AND policyname IN ('maintenance_insert','maintenance_update','maintenance_delete','maintenance_insert_boundary','maintenance_update_boundary','maintenance_delete_boundary')`,
    );
    for (const p of policies)
      await r.query(
        `DROP POLICY "${p.policyname}" ON organizations.tenant_directory`,
      );
  }
}
