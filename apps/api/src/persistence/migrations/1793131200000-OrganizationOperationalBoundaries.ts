import type { MigrationInterface, QueryRunner } from 'typeorm';

// Additive boundary change. Historical migrations and persisted audit stay intact.
const uuid = (setting: string) =>
  `CASE WHEN current_setting('innoview.${setting}',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN current_setting('innoview.${setting}',true)::uuid ELSE NULL::uuid END`;
export class OrganizationOperationalBoundaries1793131200000 implements MigrationInterface {
  name = 'OrganizationOperationalBoundaries1793131200000';
  async up(r: QueryRunner) {
    const roles = await r.manager.query<{ kind: string; name: string }[]>(
      `SELECT split_part(shobj_description(oid,'pg_authid'),':',3) AS kind,quote_ident(rolname) AS name FROM pg_roles WHERE left(shobj_description(oid,'pg_authid'),length('innoview:'||current_database()||':'))='innoview:'||current_database()||':'`,
    );
    const role = (kind: string) => {
      const matches = roles.filter((row) => row.kind === kind);
      if (matches.length !== 1)
        throw new Error('Required managed operational role missing');
      return matches[0].name;
    };
    const operator = role('organizations'),
      provisioner = role('organizations_provisioner'),
      maintenance = role('directory_maintenance');
    for (const table of [
      'tenant',
      'organizational_unit',
      'business_group',
      'company',
      'branch',
      'tenant_directory',
      'audit_event',
      'operation',
    ]) {
      await r.query(
        `GRANT USAGE ON SCHEMA organizations TO ${provisioner},${maintenance}`,
      );
      if (!['company', 'branch'].includes(table))
        await r.query(
          `GRANT SELECT ON organizations.${table} TO ${maintenance}`,
        );
      if (!['company', 'branch'].includes(table))
        await r.query(
          `GRANT SELECT,INSERT ON organizations.${table} TO ${provisioner}`,
        );
      if (table === 'tenant')
        await r.query(
          `GRANT UPDATE(id) ON organizations.tenant TO ${provisioner}`,
        );
      if (table === 'operation')
        await r.query(
          `GRANT UPDATE(tenant_id,result,completed_at) ON organizations.operation TO ${provisioner}`,
        );
      if (table === 'tenant_directory')
        await r.query(
          `GRANT UPDATE ON organizations.tenant_directory TO ${provisioner}`,
        );
      const key = table === 'tenant' ? 'id' : 'tenant_id';
      const boundary = `${key} = ${uuid('tenant_id')}`;
      const existing = await r.manager.query<{ policyname: string }[]>(
        `SELECT policyname FROM pg_policies WHERE schemaname='organizations' AND tablename=$1 AND policyname IN ('operator_select','operator_insert','operator_update')`,
        [table],
      );
      for (const policy of existing)
        await r.query(
          `DROP POLICY "${policy.policyname}" ON organizations.${table}`,
        );
      await r.query(
        `CREATE POLICY operator_boundary ON organizations.${table} AS RESTRICTIVE FOR ALL TO ${operator} USING(${boundary}) WITH CHECK(${boundary})`,
      );
      await r.query(
        `CREATE POLICY operator_select ON organizations.${table} FOR SELECT TO ${operator} USING(${boundary})`,
      );
      if (table !== 'tenant')
        await r.query(
          `CREATE POLICY operator_insert ON organizations.${table} FOR INSERT TO ${operator} WITH CHECK(${boundary}${table === 'organizational_unit' ? " AND type<>'GROUP'" : table === 'operation' ? " AND operation_type<>'CREATE_TENANT'" : ''})`,
        );
      if (
        [
          'tenant',
          'organizational_unit',
          'tenant_directory',
          'operation',
        ].includes(table)
      )
        await r.query(
          `CREATE POLICY operator_update ON organizations.${table} FOR UPDATE TO ${operator} USING(${boundary}) WITH CHECK(${boundary})`,
        );
      await r.query(`REVOKE INSERT ON organizations.tenant FROM ${operator}`);
      // Complete global read is an explicit isolated diagnostic capability, not
      // available to the ordinary writer, API or BFF. No source writes.
      if (!['company', 'branch'].includes(table))
        await r.query(
          `CREATE POLICY maintenance_select ON organizations.${table} FOR SELECT TO ${maintenance} USING(true)`,
        );
      if (['company', 'branch'].includes(table)) continue;
      const pretenant =
        table === 'operation'
          ? `operation_type='CREATE_TENANT' AND request_id=${uuid('organization_request')} AND (tenant_id IS NULL OR ${boundary} OR completed_at IS NOT NULL)`
          : boundary +
            (table === 'organizational_unit' ? " AND type='GROUP'" : '');
      await r.query(
        `CREATE POLICY provisioner_boundary ON organizations.${table} AS RESTRICTIVE FOR ALL TO ${provisioner} USING(${pretenant}) WITH CHECK(${pretenant})`,
      );
      await r.query(
        `CREATE POLICY provisioner_select ON organizations.${table} FOR SELECT TO ${provisioner} USING(${pretenant})`,
      );
      await r.query(
        `CREATE POLICY provisioner_insert ON organizations.${table} FOR INSERT TO ${provisioner} WITH CHECK(${pretenant})`,
      );
      if (['tenant', 'tenant_directory', 'operation'].includes(table))
        await r.query(
          `CREATE POLICY provisioner_update ON organizations.${table} FOR UPDATE TO ${provisioner} USING(${pretenant}) WITH CHECK(${pretenant})`,
        );
    }
    await r.query(`CREATE OR REPLACE FUNCTION organizations.guard_operator_write() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE operation_text text; operation_uuid uuid;
      BEGIN
        operation_text=current_setting('innoview.organization_request',true);
        IF operation_text IS NULL OR operation_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN RAISE EXCEPTION 'Canonical operation context required' USING ERRCODE='42501'; END IF;
        operation_uuid=operation_text::uuid;
        IF TG_OP='DELETE' OR COALESCE((SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user),'') NOT IN ('innoview:'||current_database()||':organizations','innoview:'||current_database()||':organizations_provisioner')
          OR NOT EXISTS(SELECT 1 FROM organizations.operation o WHERE o.request_id=operation_uuid
            AND o.completed_at IS NULL AND o.actor=current_setting('innoview.organization_actor',true)
            AND o.reason=current_setting('innoview.organization_reason',true) AND o.actor_type=current_setting('innoview.organization_actor_type',true))
        THEN RAISE EXCEPTION 'Trusted organization operation required' USING ERRCODE='42501'; END IF;
        IF TG_OP<>'INSERT' AND (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user)='innoview:'||current_database()||':organizations_provisioner'
        THEN RAISE EXCEPTION 'Pretenant capability is insert only' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
    await r.query(`CREATE OR REPLACE FUNCTION organizations.audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE tid uuid; previous text; following text; operation_text text; operation_uuid uuid;
      BEGIN
        operation_text=current_setting('innoview.organization_request',true);
        IF operation_text IS NULL OR operation_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN RAISE EXCEPTION 'Canonical operation context required' USING ERRCODE='42501'; END IF;
        operation_uuid=operation_text::uuid;
        IF COALESCE((SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user),'') NOT IN ('innoview:'||current_database()||':organizations','innoview:'||current_database()||':organizations_provisioner')
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
    await r.query(`CREATE OR REPLACE FUNCTION organizations.guard_operation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      DECLARE operation_text text; operation_uuid uuid;
      BEGIN
        IF TG_OP='DELETE' OR COALESCE((SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user),'') NOT IN ('innoview:'||current_database()||':organizations','innoview:'||current_database()||':organizations_provisioner')
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
        IF ((SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user)='innoview:'||current_database()||':organizations_provisioner') IS DISTINCT FROM (NEW.operation_type='CREATE_TENANT')
        THEN RAISE EXCEPTION 'Operational capability mismatch' USING ERRCODE='42501'; END IF;
        IF NEW.operation_type='CREATE_TENANT' AND ((TG_OP='INSERT' AND NEW.tenant_id IS NOT NULL) OR
          (TG_OP='UPDATE' AND NEW.tenant_id IS DISTINCT FROM ${uuid('tenant_id')}))
        THEN RAISE EXCEPTION 'Pretenant target mismatch' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
    await r.query(`CREATE OR REPLACE FUNCTION organizations.guard_derived_write() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF TG_OP='DELETE' OR (TG_TABLE_NAME='audit_event' AND TG_OP<>'INSERT') OR pg_trigger_depth()<>2
          OR COALESCE((SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user),'') NOT IN ('innoview:'||current_database()||':organizations','innoview:'||current_database()||':organizations_provisioner')
        THEN RAISE EXCEPTION 'Derived organization record is protected' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
  }
  async down(r: QueryRunner) {
    // Frozen pre-2.5 trigger bodies are restored only in disposable rollback.
    await r.query(`CREATE OR REPLACE FUNCTION organizations.guard_operator_write() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
    await r.query(`CREATE OR REPLACE FUNCTION organizations.audit_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
    await r.query(`CREATE OR REPLACE FUNCTION organizations.guard_operation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
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
    await r.query(`CREATE OR REPLACE FUNCTION organizations.guard_derived_write() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
      BEGIN
        IF TG_OP='DELETE' OR (TG_TABLE_NAME='audit_event' AND TG_OP<>'INSERT') OR pg_trigger_depth()<>2
          OR (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=current_user)
             IS DISTINCT FROM 'innoview:'||current_database()||':organizations'
        THEN RAISE EXCEPTION 'Derived organization record is protected' USING ERRCODE='42501'; END IF;
        RETURN NEW;
      END $$`);
    const roles = await r.manager.query<{ name: string }[]>(
      `SELECT quote_ident(rolname) AS name FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':organizations'`,
    );
    const operator = roles[0].name;
    for (const table of [
      'tenant',
      'organizational_unit',
      'business_group',
      'company',
      'branch',
      'tenant_directory',
      'audit_event',
      'operation',
    ]) {
      const policies = await r.manager.query<{ policyname: string }[]>(
        `SELECT policyname FROM pg_policies WHERE schemaname='organizations' AND tablename=$1 AND policyname IN ('operator_boundary','operator_select','operator_insert','operator_update','provisioner_boundary','provisioner_select','provisioner_insert','provisioner_update','maintenance_select')`,
        [table],
      );
      for (const p of policies)
        await r.query(
          `DROP POLICY "${p.policyname}" ON organizations.${table}`,
        );
      await r.query(
        `CREATE POLICY operator_select ON organizations.${table} FOR SELECT TO ${operator} USING(true)`,
      );
      await r.query(
        `CREATE POLICY operator_insert ON organizations.${table} FOR INSERT TO ${operator} WITH CHECK(true)`,
      );
      if (
        [
          'tenant',
          'organizational_unit',
          'tenant_directory',
          'operation',
        ].includes(table)
      )
        await r.query(
          `CREATE POLICY operator_update ON organizations.${table} FOR UPDATE TO ${operator} USING(true) WITH CHECK(true)`,
        );
    }
    await r.query(`GRANT INSERT ON organizations.tenant TO ${operator}`);
  }
}
