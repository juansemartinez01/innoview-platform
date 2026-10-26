import type { MigrationInterface, QueryRunner } from 'typeorm';

export class OrganizationOperations1793023200000 implements MigrationInterface {
  name = 'OrganizationOperations1793023200000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE organizations.operation (
      request_id uuid PRIMARY KEY,
      tenant_id uuid REFERENCES organizations.tenant(id) ON DELETE RESTRICT,
      operation_type text NOT NULL CHECK(operation_type IN ('CREATE_TENANT','CREATE_COMPANY','CREATE_BRANCH','SET_STATUS')),
      fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
      actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 200),
      actor_type text NOT NULL CHECK(actor_type IN ('INNOVIEW_OPERATOR','SYSTEM','USER_IDENTITY')),
      actor_identity_id uuid REFERENCES identity.user_identity(id) ON DELETE RESTRICT,
      reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
      technical_source text NOT NULL,
      result jsonb,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      completed_at timestamptz,
      CHECK((actor_type='USER_IDENTITY')=(actor_identity_id IS NOT NULL))
    )`);
    await runner.query(
      'CREATE INDEX operation_tenant_created ON organizations.operation(tenant_id,created_at)',
    );
    await runner.query(`ALTER TABLE organizations.audit_event
      ADD COLUMN actor_type text NOT NULL DEFAULT 'LEGACY_UNVERIFIED',
      ADD COLUMN actor_identity_id uuid REFERENCES identity.user_identity(id) ON DELETE RESTRICT,
      ADD COLUMN reason text,
      ADD COLUMN technical_source text,
      ADD COLUMN operation_request_id uuid REFERENCES organizations.operation(request_id) ON DELETE RESTRICT,
      ADD CONSTRAINT audit_provenance CHECK (
        (actor_type='LEGACY_UNVERIFIED' AND actor_identity_id IS NULL AND operation_request_id IS NULL AND reason IS NULL)
        OR (actor_type IN ('INNOVIEW_OPERATOR','SYSTEM','USER_IDENTITY') AND operation_request_id IS NOT NULL AND reason IS NOT NULL
          AND (actor_type='USER_IDENTITY')=(actor_identity_id IS NOT NULL)))`);
    await runner.query(
      'CREATE INDEX audit_operation_request ON organizations.audit_event(operation_request_id)',
    );
    await runner.query(`CREATE FUNCTION organizations.guard_operation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.completed_at IS NOT NULL)
          OR (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':organizations'
        THEN RAISE EXCEPTION 'Operation history protected' USING ERRCODE='42501'; END IF;
        IF TG_OP='INSERT' AND (NEW.result IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.actor_type NOT IN ('INNOVIEW_OPERATOR','SYSTEM') OR NEW.actor_identity_id IS NOT NULL
          OR NEW.actor IS DISTINCT FROM current_setting('innoview.organization_actor',true)
          OR NEW.reason IS DISTINCT FROM current_setting('innoview.organization_reason',true)
          OR NEW.actor_type IS DISTINCT FROM current_setting('innoview.organization_actor_type',true)
          OR NEW.request_id::text IS DISTINCT FROM current_setting('innoview.organization_request',true))
        THEN RAISE EXCEPTION 'Verified technical operation required' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE FUNCTION organizations.assert_operation_complete() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM organizations.operation WHERE request_id=NEW.request_id AND (result IS NULL OR completed_at IS NULL OR tenant_id IS NULL))
        THEN RAISE EXCEPTION 'Operation must complete atomically' USING ERRCODE='23514'; END IF;
        RETURN NULL;
      END $$`);
    await runner.query(
      'CREATE TRIGGER operation_guard BEFORE INSERT OR UPDATE OR DELETE ON organizations.operation FOR EACH ROW EXECUTE FUNCTION organizations.guard_operation()',
    );
    await runner.query(
      'CREATE CONSTRAINT TRIGGER operation_complete AFTER INSERT OR UPDATE ON organizations.operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION organizations.assert_operation_complete()',
    );
    await runner.query(`CREATE OR REPLACE FUNCTION organizations.guard_operator_write() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF TG_OP='DELETE' OR (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':organizations'
          OR NOT EXISTS(SELECT 1 FROM organizations.operation WHERE request_id::text=current_setting('innoview.organization_request',true)
            AND completed_at IS NULL AND actor=current_setting('innoview.organization_actor',true)
            AND reason=current_setting('innoview.organization_reason',true) AND actor_type=current_setting('innoview.organization_actor_type',true))
        THEN RAISE EXCEPTION 'Trusted organization operation required' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE OR REPLACE FUNCTION organizations.audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE tid uuid; previous text; following text;
      BEGIN
        IF TG_OP='UPDATE' THEN
          previous=to_jsonb(OLD)->>'status'; following=to_jsonb(NEW)->>'status';
          IF previous IS NOT DISTINCT FROM following THEN RETURN NEW; END IF;
        ELSE following=to_jsonb(NEW)->>'status'; END IF;
        IF TG_TABLE_NAME='tenant' THEN tid=NEW.id; ELSE tid=NEW.tenant_id; END IF;
        INSERT INTO organizations.audit_event(tenant_id,record_id,record_type,action,old_status,new_status,actor,db_actor,request_id,actor_type,reason,technical_source,operation_request_id)
          SELECT tid,NEW.id,TG_TABLE_NAME,CASE WHEN TG_OP='INSERT' THEN 'INSERT' ELSE 'STATUS_CHANGED' END,
            previous,following,o.actor,current_user,o.request_id,o.actor_type,o.reason,o.technical_source,o.request_id
          FROM organizations.operation o WHERE o.request_id::text=current_setting('innoview.organization_request',true) AND o.completed_at IS NULL;
        IF NOT FOUND THEN RAISE EXCEPTION 'Operation required' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`DO $$ DECLARE operator text; BEGIN
      SELECT rolname INTO STRICT operator FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':organizations';
      EXECUTE format('GRANT SELECT,INSERT ON organizations.operation TO %I',operator);
      EXECUTE format('GRANT UPDATE(tenant_id,result,completed_at) ON organizations.operation TO %I',operator);
      EXECUTE format('CREATE POLICY operator_select ON organizations.operation FOR SELECT TO %I USING(true)',operator);
      EXECUTE format('CREATE POLICY operator_insert ON organizations.operation FOR INSERT TO %I WITH CHECK(true)',operator);
      EXECUTE format('CREATE POLICY operator_update ON organizations.operation FOR UPDATE TO %I USING(true) WITH CHECK(true)',operator);
    END $$`);
    await runner.query(
      'ALTER TABLE organizations.operation ENABLE ROW LEVEL SECURITY',
    );
    await runner.query(
      'ALTER TABLE organizations.operation FORCE ROW LEVEL SECURITY',
    );
    await runner.query(
      'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA organizations FROM PUBLIC',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    // Disposable only; preserve the former 2.2 contract when stepping back.
    await runner.query(`CREATE OR REPLACE FUNCTION organizations.guard_operator_write() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF TG_OP='DELETE' OR (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':organizations'
          OR NULLIF(current_setting('innoview.organization_actor',true),'') IS NULL
          OR COALESCE(current_setting('innoview.organization_request',true),'') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN RAISE EXCEPTION 'Trusted organization operation required' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE OR REPLACE FUNCTION organizations.audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE tid uuid; previous text; following text;
      BEGIN
        IF TG_OP='UPDATE' THEN
          previous=to_jsonb(OLD)->>'status'; following=to_jsonb(NEW)->>'status';
          IF previous IS NOT DISTINCT FROM following THEN RETURN NEW; END IF;
        ELSE following=to_jsonb(NEW)->>'status'; END IF;
        IF TG_TABLE_NAME='tenant' THEN tid=NEW.id; ELSE tid=NEW.tenant_id; END IF;
        INSERT INTO organizations.audit_event(tenant_id,record_id,record_type,action,old_status,new_status,actor,db_actor,request_id)
          VALUES(tid,NEW.id,TG_TABLE_NAME,CASE WHEN TG_OP='INSERT' THEN 'INSERT' ELSE 'STATUS_CHANGED' END,previous,following,current_setting('innoview.organization_actor'),current_user,current_setting('innoview.organization_request')::uuid);
        RETURN NEW;
      END $$`);
    await runner.query(
      'ALTER TABLE organizations.audit_event DROP CONSTRAINT audit_provenance, DROP COLUMN actor_type,DROP COLUMN actor_identity_id,DROP COLUMN reason,DROP COLUMN technical_source,DROP COLUMN operation_request_id',
    );
    await runner.query('DROP TABLE organizations.operation');
    await runner.query(
      'DROP FUNCTION organizations.guard_operation(), organizations.assert_operation_complete()',
    );
  }
}
