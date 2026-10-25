import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Organizations1792929600000 implements MigrationInterface {
  name = 'Organizations1792929600000';

  async up(runner: QueryRunner): Promise<void> {
    const [schema] = (await runner.query(
      "SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_namespace WHERE nspname='organizations'",
    )) as { owned: boolean }[];
    if (!schema?.owned)
      throw new Error(
        'Provision the managed organizations schema before migrating',
      );
    // TypeORM reads STORED expressions from its private metadata, not only
    // pg_attribute. Version these entries to keep generate --check stable.
    await runner.query(`CREATE TABLE IF NOT EXISTS platform_meta.typeorm_metadata (
      "type" varchar NOT NULL, "database" varchar, "schema" varchar,
      "table" varchar, "name" varchar, "value" text
    )`);
    for (const [table, kind] of [
      ['business_group', 'GROUP'],
      ['company', 'COMPANY'],
      ['branch', 'BRANCH'],
    ])
      await runner.query(
        `INSERT INTO platform_meta.typeorm_metadata("type","database","schema","table","name","value") VALUES ('GENERATED_COLUMN',current_database(),'organizations',$1,'unit_type',$2)`,
        [table, `'${kind}'::character varying`],
      );
    await runner.query(`CREATE TABLE organizations.tenant (
      id uuid NOT NULL DEFAULT gen_random_uuid() CONSTRAINT pk_tenant PRIMARY KEY,
      name varchar(200) NOT NULL, status varchar(10) NOT NULL DEFAULT 'ACTIVE',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ck_tenant_name CHECK (length(btrim(name)) > 0),
      CONSTRAINT ck_tenant_status CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED'))
    )`);
    await runner.query(`CREATE TABLE organizations.organizational_unit (
      id uuid NOT NULL DEFAULT gen_random_uuid() CONSTRAINT pk_unit PRIMARY KEY,
      tenant_id uuid NOT NULL, type varchar(10) NOT NULL, name varchar(200) NOT NULL,
      status varchar(10) NOT NULL DEFAULT 'ACTIVE',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_unit_tenant_id_type UNIQUE (tenant_id,id,type),
      CONSTRAINT uq_unit_tenant_id UNIQUE (tenant_id,id),
      CONSTRAINT ck_unit_name CHECK (length(btrim(name)) > 0),
      CONSTRAINT ck_unit_status CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED')),
      CONSTRAINT ck_unit_type CHECK (type IN ('GROUP','COMPANY','BRANCH')),
      CONSTRAINT fk_unit_tenant FOREIGN KEY (tenant_id) REFERENCES organizations.tenant(id) ON DELETE RESTRICT ON UPDATE RESTRICT
    )`);
    await runner.query(`CREATE TABLE organizations.business_group (
      tenant_id uuid NOT NULL, id uuid NOT NULL,
      unit_type varchar(10) GENERATED ALWAYS AS ('GROUP'::character varying) STORED NOT NULL,
      CONSTRAINT pk_business_group PRIMARY KEY (tenant_id,id),
      CONSTRAINT uq_group_tenant UNIQUE (tenant_id),
      CONSTRAINT fk_business_group_unit FOREIGN KEY (tenant_id,id,unit_type) REFERENCES organizations.organizational_unit(tenant_id,id,type) ON DELETE RESTRICT ON UPDATE RESTRICT
    )`);
    await runner.query(`CREATE TABLE organizations.company (
      tenant_id uuid NOT NULL, id uuid NOT NULL,
      unit_type varchar(10) GENERATED ALWAYS AS ('COMPANY'::character varying) STORED NOT NULL,
      business_group_id uuid NOT NULL, tax_id varchar(80),
      CONSTRAINT pk_company PRIMARY KEY (tenant_id,id),
      CONSTRAINT fk_company_unit FOREIGN KEY (tenant_id,id,unit_type) REFERENCES organizations.organizational_unit(tenant_id,id,type) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_company_parent FOREIGN KEY (tenant_id,business_group_id) REFERENCES organizations.business_group(tenant_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT
    )`);
    await runner.query(`CREATE TABLE organizations.branch (
      tenant_id uuid NOT NULL, id uuid NOT NULL,
      unit_type varchar(10) GENERATED ALWAYS AS ('BRANCH'::character varying) STORED NOT NULL,
      company_id uuid NOT NULL,
      CONSTRAINT pk_branch PRIMARY KEY (tenant_id,id),
      CONSTRAINT fk_branch_unit FOREIGN KEY (tenant_id,id,unit_type) REFERENCES organizations.organizational_unit(tenant_id,id,type) ON DELETE RESTRICT ON UPDATE RESTRICT,
      CONSTRAINT fk_branch_parent FOREIGN KEY (tenant_id,company_id) REFERENCES organizations.company(tenant_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT
    )`);
    // Referencing columns are indexed by their tenant-leading primary/unique keys.
    // Composite parent indexes also support future scoped queries and FK checks.
    await runner.query(
      'CREATE INDEX ix_company_parent ON organizations.company(tenant_id,business_group_id)',
    );
    await runner.query(
      'CREATE INDEX ix_branch_parent ON organizations.branch(tenant_id,company_id)',
    );

    await runner.query(`CREATE FUNCTION organizations.guard_lifecycle() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
      DECLARE tenant_status text; parent_status text; group_status text;
      BEGIN
        IF TG_OP='INSERT' AND NEW.status<>'ACTIVE' THEN
          RAISE EXCEPTION 'Initial organizational state must be ACTIVE' USING ERRCODE='23514';
        END IF;
        IF TG_OP='UPDATE' THEN
          IF NEW.id IS DISTINCT FROM OLD.id OR (OLD.status='ARCHIVED' AND NEW.status<>'ARCHIVED') THEN
            RAISE EXCEPTION 'Immutable identifier or terminal state' USING ERRCODE='23514';
          END IF;
          IF NEW.status IS DISTINCT FROM OLD.status THEN NEW.updated_at=clock_timestamp();
          ELSE NEW.updated_at=OLD.updated_at; END IF;
        END IF;
        IF TG_TABLE_NAME='organizational_unit' THEN
          IF TG_OP='UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.type IS DISTINCT FROM OLD.type) THEN
            RAISE EXCEPTION 'Unit tenant and type are immutable' USING ERRCODE='23514';
          END IF;
          SELECT status INTO tenant_status FROM organizations.tenant WHERE id=NEW.tenant_id FOR UPDATE;
          IF (TG_OP='INSERT' OR (TG_OP='UPDATE' AND NEW.status='ACTIVE' AND OLD.status<>'ACTIVE')) AND tenant_status IS DISTINCT FROM 'ACTIVE' THEN
            RAISE EXCEPTION 'An active tenant is required' USING ERRCODE='23514';
          END IF;
          IF TG_OP='UPDATE' AND NEW.status='ACTIVE' AND OLD.status<>'ACTIVE' THEN
            IF NEW.type='COMPANY' THEN
              SELECT u.status INTO parent_status FROM organizations.company c
                JOIN organizations.organizational_unit u ON u.tenant_id=c.tenant_id AND u.id=c.business_group_id
                WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.id;
              IF parent_status IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'Active group required' USING ERRCODE='23514'; END IF;
            ELSIF NEW.type='BRANCH' THEN
              SELECT u.status,g.status INTO parent_status,group_status FROM organizations.branch b
                JOIN organizations.company c ON c.tenant_id=b.tenant_id AND c.id=b.company_id
                JOIN organizations.organizational_unit u ON u.tenant_id=c.tenant_id AND u.id=c.id
                JOIN organizations.organizational_unit g ON g.tenant_id=c.tenant_id AND g.id=c.business_group_id
                WHERE b.tenant_id=NEW.tenant_id AND b.id=NEW.id;
              IF parent_status IS DISTINCT FROM 'ACTIVE' OR group_status IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'Active ancestors required' USING ERRCODE='23514'; END IF;
            END IF;
          END IF;
        END IF;
        RETURN NEW;
      END $$`);

    await runner.query(`CREATE FUNCTION organizations.guard_typed_parent() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
      DECLARE tenant_status text; parent_status text; group_status text;
      BEGIN
        IF TG_OP='UPDATE' THEN
          IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Immutable organizational identity' USING ERRCODE='23514'; END IF;
          IF TG_TABLE_NAME='company' AND NEW.business_group_id IS DISTINCT FROM OLD.business_group_id THEN RAISE EXCEPTION 'Immutable group association' USING ERRCODE='23514'; END IF;
          IF TG_TABLE_NAME='branch' AND NEW.company_id IS DISTINCT FROM OLD.company_id THEN RAISE EXCEPTION 'Immutable company association' USING ERRCODE='23514'; END IF;
          RETURN NEW;
        END IF;
        SELECT status INTO tenant_status FROM organizations.tenant WHERE id=NEW.tenant_id FOR UPDATE;
        IF tenant_status IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'Active tenant required' USING ERRCODE='23514'; END IF;
        IF TG_TABLE_NAME='company' THEN
          SELECT u.status INTO parent_status FROM organizations.business_group g
            JOIN organizations.organizational_unit u ON u.tenant_id=g.tenant_id AND u.id=g.id
            WHERE g.tenant_id=NEW.tenant_id AND g.id=NEW.business_group_id;
          IF FOUND AND parent_status<>'ACTIVE' THEN RAISE EXCEPTION 'Active group required' USING ERRCODE='23514'; END IF;
        ELSIF TG_TABLE_NAME='branch' THEN
          SELECT u.status,g.status INTO parent_status,group_status FROM organizations.company c
            JOIN organizations.organizational_unit u ON u.tenant_id=c.tenant_id AND u.id=c.id
            JOIN organizations.organizational_unit g ON g.tenant_id=c.tenant_id AND g.id=c.business_group_id
            WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.company_id;
          IF FOUND AND (parent_status<>'ACTIVE' OR group_status<>'ACTIVE') THEN RAISE EXCEPTION 'Active ancestors required' USING ERRCODE='23514'; END IF;
        END IF;
        RETURN NEW;
      END $$`);

    await runner.query(`CREATE FUNCTION organizations.assert_complete() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
      DECLARE target_tenant uuid; target_unit uuid; kind text; present boolean;
      BEGIN
        IF TG_TABLE_NAME='tenant' THEN
          IF TG_OP='DELETE' THEN target_tenant=OLD.id; ELSE target_tenant=NEW.id; END IF;
        ELSE
          IF TG_OP='DELETE' THEN target_tenant=OLD.tenant_id; target_unit=OLD.id;
          ELSE target_tenant=NEW.tenant_id; target_unit=NEW.id; END IF;
        END IF;
        PERFORM 1 FROM organizations.tenant WHERE id=target_tenant FOR UPDATE;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF TG_TABLE_NAME IN ('tenant','business_group') AND (SELECT count(*) FROM organizations.business_group WHERE tenant_id=target_tenant)<>1 THEN
          RAISE EXCEPTION 'Exactly one business group required per tenant' USING ERRCODE='23514';
        END IF;
        IF target_unit IS NOT NULL THEN
          SELECT type INTO kind FROM organizations.organizational_unit WHERE tenant_id=target_tenant AND id=target_unit;
          IF FOUND THEN
            CASE kind
              WHEN 'GROUP' THEN SELECT EXISTS(SELECT 1 FROM organizations.business_group WHERE tenant_id=target_tenant AND id=target_unit) INTO present;
              WHEN 'COMPANY' THEN SELECT EXISTS(SELECT 1 FROM organizations.company WHERE tenant_id=target_tenant AND id=target_unit) INTO present;
              WHEN 'BRANCH' THEN SELECT EXISTS(SELECT 1 FROM organizations.branch WHERE tenant_id=target_tenant AND id=target_unit) INTO present;
              ELSE present=false;
            END CASE;
            IF NOT present THEN RAISE EXCEPTION 'OrganizationalUnit requires its exact typed record' USING ERRCODE='23514'; END IF;
          END IF;
        END IF;
        RETURN NULL;
      END $$`);

    for (const table of ['tenant', 'organizational_unit'])
      await runner.query(
        `CREATE TRIGGER guard_lifecycle BEFORE INSERT OR UPDATE ON organizations.${table} FOR EACH ROW EXECUTE FUNCTION organizations.guard_lifecycle()`,
      );
    for (const table of ['business_group', 'company', 'branch'])
      await runner.query(
        `CREATE TRIGGER guard_typed_parent BEFORE INSERT OR UPDATE ON organizations.${table} FOR EACH ROW EXECUTE FUNCTION organizations.guard_typed_parent()`,
      );
    for (const table of [
      'tenant',
      'organizational_unit',
      'business_group',
      'company',
      'branch',
    ])
      await runner.query(
        `CREATE CONSTRAINT TRIGGER assert_complete AFTER INSERT OR UPDATE OR DELETE ON organizations.${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION organizations.assert_complete()`,
      );

    // Bootstrap already grants SELECT/INSERT defaults; only these existing
    // status-owner tables receive column UPDATE. Never grant general UPDATE.
    const [role] = (await runner.query(
      "SELECT rolname FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':app'",
    )) as { rolname: string }[];
    if (!role) throw new Error('Managed application role required');
    const quoted = '"' + role.rolname.replaceAll('"', '""') + '"';
    for (const table of ['tenant', 'organizational_unit'])
      await runner.query(
        `GRANT UPDATE(status,updated_at) ON organizations.${table} TO ${quoted}`,
      );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      `DELETE FROM platform_meta.typeorm_metadata WHERE "type"='GENERATED_COLUMN' AND "schema"='organizations' AND "table" IN ('business_group','company','branch') AND "name"='unit_type'`,
    );
    for (const table of [
      'branch',
      'company',
      'business_group',
      'organizational_unit',
      'tenant',
    ])
      await runner.query(`DROP TABLE organizations.${table}`);
    for (const fn of [
      'assert_complete',
      'guard_typed_parent',
      'guard_lifecycle',
    ])
      await runner.query(`DROP FUNCTION organizations.${fn}()`);
  }
}
