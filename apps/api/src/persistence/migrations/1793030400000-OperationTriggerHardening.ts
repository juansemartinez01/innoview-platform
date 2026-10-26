import type { MigrationInterface, QueryRunner } from 'typeorm';

export class OperationTriggerHardening1793030400000 implements MigrationInterface {
  name = 'OperationTriggerHardening1793030400000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE organizations.operation ADD COLUMN fingerprint_version smallint NOT NULL DEFAULT 1 CHECK(fingerprint_version IN (1,2))',
    );
    await runner.query(
      'ALTER TABLE organizations.operation ALTER COLUMN fingerprint_version SET DEFAULT 2',
    );
    await runner.query(
      'ALTER TABLE organizations.audit_event ALTER COLUMN actor_type DROP DEFAULT',
    );
    await runner.query(`ALTER TABLE organizations.audit_event ADD CONSTRAINT audit_verified_source
      CHECK(actor_type='LEGACY_UNVERIFIED' OR (technical_source IS NOT NULL AND length(btrim(technical_source))>0))`);
    // Validation and cast are separate PL/pgSQL statements. Never rely on SQL
    // predicate evaluation order to protect a malformed custom setting cast.
    await runner.query(`CREATE OR REPLACE FUNCTION organizations.guard_operator_write() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE operation_text text; operation_uuid uuid;
      BEGIN
        operation_text=current_setting('innoview.organization_request',true);
        IF operation_text IS NULL OR operation_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN RAISE EXCEPTION 'Canonical operation context required' USING ERRCODE='42501'; END IF;
        operation_uuid=operation_text::uuid;
        IF TG_OP='DELETE' OR (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':organizations'
          OR NOT EXISTS(SELECT 1 FROM organizations.operation o WHERE o.request_id=operation_uuid
            AND o.completed_at IS NULL AND o.actor=current_setting('innoview.organization_actor',true)
            AND o.reason=current_setting('innoview.organization_reason',true) AND o.actor_type=current_setting('innoview.organization_actor_type',true))
        THEN RAISE EXCEPTION 'Trusted organization operation required' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE OR REPLACE FUNCTION organizations.audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE tid uuid; previous text; following text; operation_text text; operation_uuid uuid;
      BEGIN
        operation_text=current_setting('innoview.organization_request',true);
        IF operation_text IS NULL OR operation_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN RAISE EXCEPTION 'Canonical operation context required' USING ERRCODE='42501'; END IF;
        operation_uuid=operation_text::uuid;
        IF (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':organizations'
        THEN RAISE EXCEPTION 'Trusted organization operation required' USING ERRCODE='42501'; END IF;
        IF TG_OP='UPDATE' THEN
          previous=to_jsonb(OLD)->>'status'; following=to_jsonb(NEW)->>'status';
          IF previous IS NOT DISTINCT FROM following THEN RETURN NEW; END IF;
        ELSE following=to_jsonb(NEW)->>'status'; END IF;
        IF TG_TABLE_NAME='tenant' THEN tid=NEW.id; ELSE tid=NEW.tenant_id; END IF;
        INSERT INTO organizations.audit_event(tenant_id,record_id,record_type,action,old_status,new_status,actor,db_actor,request_id,actor_type,reason,technical_source,operation_request_id)
          SELECT tid,NEW.id,TG_TABLE_NAME,CASE WHEN TG_OP='INSERT' THEN 'INSERT' ELSE 'STATUS_CHANGED' END,
            previous,following,o.actor,current_user,o.request_id,o.actor_type,o.reason,o.technical_source,o.request_id
          FROM organizations.operation o WHERE o.request_id=operation_uuid AND o.completed_at IS NULL
            AND o.actor=current_setting('innoview.organization_actor',true) AND o.reason=current_setting('innoview.organization_reason',true)
            AND o.actor_type=current_setting('innoview.organization_actor_type',true);
        IF NOT FOUND THEN RAISE EXCEPTION 'Operation required' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE OR REPLACE FUNCTION organizations.guard_operation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE operation_text text; operation_uuid uuid;
      BEGIN
        IF TG_OP='DELETE' OR (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':organizations'
        THEN RAISE EXCEPTION 'Operation history protected' USING ERRCODE='42501'; END IF;
        operation_text=current_setting('innoview.organization_request',true);
        IF operation_text IS NULL OR operation_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN RAISE EXCEPTION 'Canonical operation context required' USING ERRCODE='42501'; END IF;
        operation_uuid=operation_text::uuid;
        IF TG_OP='UPDATE' THEN
          IF OLD.completed_at IS NOT NULL OR OLD.request_id<>operation_uuid OR NEW.request_id<>operation_uuid
            OR OLD.actor IS DISTINCT FROM current_setting('innoview.organization_actor',true)
            OR OLD.reason IS DISTINCT FROM current_setting('innoview.organization_reason',true)
            OR OLD.actor_type IS DISTINCT FROM current_setting('innoview.organization_actor_type',true)
          THEN RAISE EXCEPTION 'Operation context mismatch or immutable history' USING ERRCODE='42501'; END IF;
        ELSIF NEW.result IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.actor_type NOT IN ('INNOVIEW_OPERATOR','SYSTEM') OR NEW.actor_identity_id IS NOT NULL
          OR NEW.actor IS DISTINCT FROM current_setting('innoview.organization_actor',true)
          OR NEW.reason IS DISTINCT FROM current_setting('innoview.organization_reason',true)
          OR NEW.actor_type IS DISTINCT FROM current_setting('innoview.organization_actor_type',true)
          OR NEW.request_id<>operation_uuid
        THEN RAISE EXCEPTION 'Verified technical operation required' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
  }
  async down(runner: QueryRunner): Promise<void> {
    // Frozen v9 definitions for disposable rollback; never edit prior migrations.
    await runner.query(`CREATE OR REPLACE FUNCTION organizations.guard_operation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
    await runner.query(
      "ALTER TABLE organizations.audit_event DROP CONSTRAINT audit_verified_source, ALTER COLUMN actor_type SET DEFAULT 'LEGACY_UNVERIFIED'",
    );
    await runner.query(
      'ALTER TABLE organizations.operation DROP COLUMN fingerprint_version',
    );
  }
}
