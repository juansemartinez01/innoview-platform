import type { MigrationInterface, QueryRunner } from 'typeorm';

// Coordinated with the independent organizations operator and the directory-only
// pretenant reader. Never run this migration with the HTTP application's role.
export class OrganizationsTenantRls1793016000000 implements MigrationInterface {
  name = 'OrganizationsTenantRls1793016000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE organizations.tenant_directory (
      tenant_id uuid PRIMARY KEY REFERENCES organizations.tenant(id) ON DELETE RESTRICT,
      tenant_name varchar(200) NOT NULL,
      group_id uuid NOT NULL,
      group_name varchar(200) NOT NULL,
      available boolean NOT NULL,
      FOREIGN KEY(tenant_id,group_id) REFERENCES organizations.business_group(tenant_id,id) ON DELETE RESTRICT
    )`);
    // Backfill existing structures before FORCE RLS is enabled. No historical
    // audit events are invented. Private attributes never enter the projection.
    await runner.query(`INSERT INTO organizations.tenant_directory
      SELECT t.id,t.name,g.id,u.name,t.status='ACTIVE' AND u.status='ACTIVE'
      FROM organizations.tenant t JOIN organizations.business_group g ON g.tenant_id=t.id
      JOIN organizations.organizational_unit u ON u.tenant_id=g.tenant_id AND u.id=g.id AND u.type='GROUP'`);
    await runner.query(`CREATE TABLE organizations.audit_event (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES organizations.tenant(id) ON DELETE RESTRICT,
      record_id uuid NOT NULL,
      record_type text NOT NULL CHECK(record_type IN ('tenant','organizational_unit','business_group','company','branch')),
      action text NOT NULL CHECK(action IN ('INSERT','STATUS_CHANGED')),
      old_status text, new_status text,
      actor text NOT NULL, db_actor text NOT NULL,
      request_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    await runner.query(`CREATE FUNCTION organizations.guard_operator_write() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF TG_OP='DELETE' OR
          (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user)
            IS DISTINCT FROM 'innoview:'||current_database()||':organizations'
          OR NULLIF(current_setting('innoview.organization_actor',true),'') IS NULL
          OR COALESCE(current_setting('innoview.organization_request',true),'') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN RAISE EXCEPTION 'Trusted organization operation required' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE FUNCTION organizations.guard_derived_write() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF TG_OP='DELETE' OR (TG_TABLE_NAME='audit_event' AND TG_OP<>'INSERT') OR pg_trigger_depth()<>2
          OR (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user)
             IS DISTINCT FROM 'innoview:'||current_database()||':organizations'
        THEN RAISE EXCEPTION 'Derived organization record is protected' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE FUNCTION organizations.audit_change() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE tid uuid; previous text; following text;
      BEGIN
        IF TG_OP='UPDATE' THEN
          previous=to_jsonb(OLD)->>'status'; following=to_jsonb(NEW)->>'status';
          IF previous IS NOT DISTINCT FROM following THEN RETURN NEW; END IF;
        ELSE following=to_jsonb(NEW)->>'status'; END IF;
        IF TG_TABLE_NAME='tenant' THEN tid=NEW.id; ELSE tid=NEW.tenant_id; END IF;
        INSERT INTO organizations.audit_event(tenant_id,record_id,record_type,action,old_status,new_status,actor,db_actor,request_id)
          VALUES(tid,NEW.id,TG_TABLE_NAME,CASE WHEN TG_OP='INSERT' THEN 'INSERT' ELSE 'STATUS_CHANGED' END,
            previous,following,current_setting('innoview.organization_actor'),current_user,current_setting('innoview.organization_request')::uuid);
        RETURN NEW;
      END $$`);
    await runner.query(`CREATE FUNCTION organizations.sync_directory() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE tid uuid;
      BEGIN
        IF TG_TABLE_NAME='tenant' THEN tid=NEW.id; ELSE tid=NEW.tenant_id; END IF;
        INSERT INTO organizations.tenant_directory(tenant_id,tenant_name,group_id,group_name,available)
          SELECT t.id,t.name,g.id,u.name,t.status='ACTIVE' AND u.status='ACTIVE'
          FROM organizations.tenant t JOIN organizations.business_group g ON g.tenant_id=t.id
          JOIN organizations.organizational_unit u ON u.tenant_id=g.tenant_id AND u.id=g.id AND u.type='GROUP'
          WHERE t.id=tid
          ON CONFLICT(tenant_id) DO UPDATE SET tenant_name=EXCLUDED.tenant_name,group_id=EXCLUDED.group_id,
            group_name=EXCLUDED.group_name,available=EXCLUDED.available;
        RETURN NULL;
      END $$`);
    for (const table of [
      'tenant',
      'organizational_unit',
      'business_group',
      'company',
      'branch',
    ]) {
      await runner.query(
        `CREATE TRIGGER operator_write BEFORE INSERT OR UPDATE OR DELETE ON organizations.${table} FOR EACH ROW EXECUTE FUNCTION organizations.guard_operator_write()`,
      );
      await runner.query(
        `CREATE TRIGGER audit_change AFTER INSERT OR UPDATE ON organizations.${table} FOR EACH ROW EXECUTE FUNCTION organizations.audit_change()`,
      );
    }
    for (const table of ['tenant', 'business_group', 'organizational_unit'])
      await runner.query(
        `CREATE CONSTRAINT TRIGGER sync_directory AFTER INSERT OR UPDATE ON organizations.${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION organizations.sync_directory()`,
      );
    for (const table of ['tenant_directory', 'audit_event'])
      await runner.query(
        `CREATE TRIGGER derived_write BEFORE INSERT OR UPDATE OR DELETE ON organizations.${table} FOR EACH ROW EXECUTE FUNCTION organizations.guard_derived_write()`,
      );

    // Role-specific permissive grants + restrictive API boundary. The directory
    // consults Memberships, whose own RLS enforces the authenticated identity.
    // Private policies consult only the directory: no recursion through private
    // Organizations tables, no views with owner privileges, no SECURITY DEFINER.
    await runner.query(`DO $$ DECLARE app text; operator text; tab text; boundary text; BEGIN
      SELECT rolname INTO STRICT app FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':app';
      SELECT rolname INTO STRICT operator FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':organizations';
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA organizations REVOKE ALL ON TABLES FROM %I',app);
      EXECUTE format('GRANT USAGE ON SCHEMA organizations TO %I',operator);
      FOREACH tab IN ARRAY ARRAY['tenant','organizational_unit','business_group','company','branch','tenant_directory','audit_event'] LOOP
        EXECUTE format('REVOKE ALL ON organizations.%I FROM PUBLIC,%I,%I',tab,app,operator);
        IF tab IN ('tenant','organizational_unit') THEN
          EXECUTE format('REVOKE UPDATE(status,updated_at) ON organizations.%I FROM %I',tab,app);
          EXECUTE format('GRANT UPDATE(status,updated_at) ON organizations.%I TO %I',tab,operator);
        END IF;
        EXECUTE format('GRANT SELECT,INSERT ON organizations.%I TO %I',tab,operator);
        EXECUTE format('CREATE POLICY operator_select ON organizations.%I FOR SELECT TO %I USING(true)',tab,operator);
        EXECUTE format('CREATE POLICY operator_insert ON organizations.%I FOR INSERT TO %I WITH CHECK(true)',tab,operator);
        IF tab IN ('tenant','organizational_unit','tenant_directory') THEN
          EXECUTE format('CREATE POLICY operator_update ON organizations.%I FOR UPDATE TO %I USING(true) WITH CHECK(true)',tab,operator);
        END IF;
        IF tab='tenant_directory' THEN
          EXECUTE format('GRANT UPDATE ON organizations.tenant_directory TO %I',operator);
          EXECUTE format('GRANT SELECT(tenant_id,tenant_name,group_id,group_name,available) ON organizations.tenant_directory TO %I',app);
          boundary='available AND EXISTS(SELECT 1 FROM memberships.membership m WHERE m.tenant_id=tenant_directory.tenant_id AND m.status=''ACTIVE'' AND m.user_identity_id::text=NULLIF(current_setting(''innoview.user_identity_id'',true),''''))';
        ELSIF tab<>'audit_event' THEN
          EXECUTE format('GRANT SELECT ON organizations.%I TO %I',tab,app);
          boundary=format('%I::text=NULLIF(current_setting(''innoview.tenant_id'',true),'''') AND EXISTS(SELECT 1 FROM organizations.tenant_directory d WHERE d.tenant_id=%I.%I AND d.available)',CASE WHEN tab='tenant' THEN 'id' ELSE 'tenant_id' END,tab,CASE WHEN tab='tenant' THEN 'id' ELSE 'tenant_id' END);
        END IF;
        IF tab<>'audit_event' THEN
          EXECUTE format('CREATE POLICY app_select ON organizations.%I FOR SELECT TO %I USING(%s)',tab,app,boundary);
          EXECUTE format('CREATE POLICY app_boundary ON organizations.%I AS RESTRICTIVE FOR ALL TO %I USING(%s) WITH CHECK(false)',tab,app,boundary);
        END IF;
        EXECUTE format('ALTER TABLE organizations.%I ENABLE ROW LEVEL SECURITY',tab);
        EXECUTE format('ALTER TABLE organizations.%I FORCE ROW LEVEL SECURITY',tab);
      END LOOP;
    END $$`);
    await runner.query(
      'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA organizations FROM PUBLIC',
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    // Only the already guarded disposable migration CLI permits reverting.
    for (const table of [
      'tenant',
      'organizational_unit',
      'business_group',
      'company',
      'branch',
    ]) {
      await runner.query(
        `DROP TRIGGER operator_write ON organizations.${table}`,
      );
      await runner.query(`DROP TRIGGER audit_change ON organizations.${table}`);
      if (['tenant', 'organizational_unit', 'business_group'].includes(table))
        await runner.query(
          `DROP TRIGGER sync_directory ON organizations.${table}`,
        );
      for (const policy of [
        'app_select',
        'app_boundary',
        'operator_select',
        'operator_insert',
        ...(['tenant', 'organizational_unit'].includes(table)
          ? ['operator_update']
          : []),
      ])
        await runner.query(`DROP POLICY ${policy} ON organizations.${table}`);
      await runner.query(
        `ALTER TABLE organizations.${table} NO FORCE ROW LEVEL SECURITY`,
      );
      await runner.query(
        `ALTER TABLE organizations.${table} DISABLE ROW LEVEL SECURITY`,
      );
    }
    await runner.query(
      'DROP TABLE organizations.tenant_directory, organizations.audit_event',
    );
    for (const fn of [
      'guard_operator_write',
      'guard_derived_write',
      'audit_change',
      'sync_directory',
    ])
      await runner.query(`DROP FUNCTION organizations.${fn}()`);
    // Do not restore unsafe API writes. Reapply + provision before resuming code.
  }
}
