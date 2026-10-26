import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Memberships1792994400000 implements MigrationInterface {
  name = 'Memberships1792994400000';
  async up(runner: QueryRunner): Promise<void> {
    const [schema] = (await runner.query(
      `SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_namespace WHERE nspname='memberships'`,
    )) as { owned: boolean }[];
    if (!schema?.owned)
      throw new Error('Provision memberships before migrating');
    await runner.query(`CREATE TABLE memberships.membership (
      id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_identity_id uuid NOT NULL,
      status varchar(10) NOT NULL DEFAULT 'ACTIVE', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz, revoked_by varchar(200), revoked_reason varchar(500),
      CONSTRAINT pk_membership PRIMARY KEY(id),
      CONSTRAINT uq_membership_tenant_identity UNIQUE(tenant_id,user_identity_id),
      CONSTRAINT uq_membership_tenant_id UNIQUE(tenant_id,id),
      CONSTRAINT fk_membership_tenant FOREIGN KEY(tenant_id) REFERENCES organizations.tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_membership_identity FOREIGN KEY(user_identity_id) REFERENCES identity.user_identity(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT ck_membership_state CHECK ((status='ACTIVE' AND revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL) OR (status='REVOKED' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_reason IS NOT NULL AND length(btrim(revoked_by))>0 AND length(btrim(revoked_reason))>0))
    )`);
    // Own directory lookup, without an organization-data join.
    await runner.query(
      'CREATE INDEX ix_membership_identity_status ON memberships.membership(user_identity_id,status)',
    );
    await runner.query(`CREATE TABLE memberships.audit_event (
      id uuid NOT NULL DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, membership_id uuid NOT NULL,
      event_type varchar(7) NOT NULL, source varchar(9) NOT NULL, actor varchar(200) NOT NULL, reason varchar(500) NOT NULL,
      request_id uuid NOT NULL, db_actor varchar(63) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_membership_audit PRIMARY KEY(id),
      CONSTRAINT uq_membership_audit_request UNIQUE(request_id),
      CONSTRAINT uq_membership_audit_transition UNIQUE(membership_id,event_type),
      CONSTRAINT fk_membership_audit_membership FOREIGN KEY(tenant_id,membership_id) REFERENCES memberships.membership(tenant_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT ck_membership_audit_type CHECK (event_type IN ('CREATED','REVOKED') AND source IN ('BOOTSTRAP','TRUSTED')),
      CONSTRAINT ck_membership_audit_context CHECK (length(btrim(actor))>0 AND length(btrim(reason))>0 AND length(btrim(db_actor))>0)
    )`);
    await runner.query(`CREATE FUNCTION memberships.guard_write() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
    DECLARE actor text := current_setting('innoview.membership_actor',true);
      reason text := current_setting('innoview.membership_reason',true);
      source text := current_setting('innoview.membership_source',true);
      request text := current_setting('innoview.membership_request',true);
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Membership history is immutable' USING ERRCODE='42501'; END IF;
      IF (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM 'innoview:'||current_database()||':membership'
        OR actor IS NULL OR length(btrim(actor)) NOT BETWEEN 1 AND 200 OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 1 AND 500
        OR source IS NULL OR source NOT IN ('BOOTSTRAP','TRUSTED') OR request IS NULL OR request !~ '^[0-9a-f-]{36}$'
      THEN RAISE EXCEPTION 'Trusted membership operation context required' USING ERRCODE='42501'; END IF;
      PERFORM request::uuid;
      PERFORM pg_advisory_xact_lock(hashtextextended('memberships:request:'||request,0));
      PERFORM pg_advisory_xact_lock(hashtextextended('memberships:tenant:'||NEW.tenant_id::text,0));
      IF TG_OP='INSERT' THEN
        IF NEW.status<>'ACTIVE' OR NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoked_reason IS NOT NULL THEN
          RAISE EXCEPTION 'New membership must be active' USING ERRCODE='23514'; END IF;
        IF source='BOOTSTRAP' AND EXISTS(SELECT 1 FROM memberships.membership WHERE tenant_id=NEW.tenant_id) THEN
          RAISE EXCEPTION 'Tenant already has membership history' USING ERRCODE='23514'; END IF;
        NEW.created_at:=clock_timestamp(); NEW.updated_at:=NEW.created_at;
      ELSE
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.user_identity_id IS DISTINCT FROM OLD.user_identity_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'Membership references are immutable' USING ERRCODE='23514'; END IF;
        IF NEW.status=OLD.status THEN RETURN OLD; END IF;
        IF OLD.status<>'ACTIVE' OR NEW.status<>'REVOKED' OR source<>'TRUSTED' THEN RAISE EXCEPTION 'Invalid membership transition' USING ERRCODE='23514'; END IF;
        NEW.revoked_at:=clock_timestamp(); NEW.updated_at:=NEW.revoked_at; NEW.revoked_by:=actor; NEW.revoked_reason:=reason;
      END IF;
      RETURN NEW;
    END $$`);
    await runner.query(`CREATE FUNCTION memberships.guard_audit() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
    BEGIN
      IF TG_OP<>'INSERT' OR pg_trigger_depth()<>2 THEN RAISE EXCEPTION 'Audit is append-only and trigger-owned' USING ERRCODE='42501'; END IF;
      NEW.db_actor:=current_user; NEW.created_at:=clock_timestamp(); RETURN NEW;
    END $$`);
    await runner.query(`CREATE FUNCTION memberships.append_audit() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
    BEGIN
      IF TG_OP='UPDATE' AND NEW.status=OLD.status THEN RETURN NULL; END IF;
      INSERT INTO memberships.audit_event(tenant_id,membership_id,event_type,source,actor,reason,request_id,db_actor)
      VALUES(NEW.tenant_id,NEW.id,CASE WHEN TG_OP='INSERT' THEN 'CREATED' ELSE 'REVOKED' END,
        current_setting('innoview.membership_source'),current_setting('innoview.membership_actor'),current_setting('innoview.membership_reason'),current_setting('innoview.membership_request')::uuid,current_user);
      RETURN NULL;
    END $$`);
    await runner.query(
      'CREATE TRIGGER membership_guard BEFORE INSERT OR UPDATE OR DELETE ON memberships.membership FOR EACH ROW EXECUTE FUNCTION memberships.guard_write()',
    );
    await runner.query(
      'CREATE TRIGGER membership_audit AFTER INSERT OR UPDATE ON memberships.membership FOR EACH ROW EXECUTE FUNCTION memberships.append_audit()',
    );
    await runner.query(
      'CREATE TRIGGER audit_guard BEFORE INSERT OR UPDATE OR DELETE ON memberships.audit_event FOR EACH ROW EXECUTE FUNCTION memberships.guard_audit()',
    );
    // No future-table grants: every new Memberships object needs review.
    await runner.query(`DO $$ DECLARE app text; operator text; BEGIN
      SELECT rolname INTO STRICT app FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':app';
      SELECT rolname INTO STRICT operator FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':membership';
      EXECUTE format('GRANT USAGE ON SCHEMA memberships TO %I, %I',app,operator);
      EXECUTE format('GRANT SELECT ON memberships.membership TO %I',app);
      EXECUTE format('GRANT SELECT,INSERT ON memberships.membership, memberships.audit_event TO %I',operator);
      EXECUTE format('GRANT UPDATE(status,updated_at) ON memberships.membership TO %I',operator);
    END $$`);
  }
  async down(runner: QueryRunner): Promise<void> {
    // CLI reversion additionally requires an explicitly disposable test DB.
    await runner.query('DROP TABLE memberships.audit_event');
    await runner.query('DROP TABLE memberships.membership');
    await runner.query('DROP FUNCTION memberships.append_audit()');
    await runner.query('DROP FUNCTION memberships.guard_audit()');
    await runner.query('DROP FUNCTION memberships.guard_write()');
  }
}
