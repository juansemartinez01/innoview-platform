import type { MigrationInterface, QueryRunner } from 'typeorm';

export class MembershipIdentityRls1793008800000 implements MigrationInterface {
  name = 'MembershipIdentityRls1793008800000';
  async up(runner: QueryRunner): Promise<void> {
    // Managed actor OIDs, not role names supplied by an HTTP client. No grants,
    // ownership changes, SECURITY DEFINER functions or BYPASSRLS shortcuts.
    await runner.query(`DO $$ DECLARE app text; operator text; BEGIN
      SELECT rolname INTO STRICT app FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':app';
      SELECT rolname INTO STRICT operator FROM pg_roles WHERE shobj_description(oid,'pg_authid')='innoview:'||current_database()||':membership';
      EXECUTE format('CREATE POLICY membership_app_select ON memberships.membership FOR SELECT TO %I USING (user_identity_id::text = NULLIF(current_setting(''innoview.user_identity_id'',true),''''))',app);
      -- A later permissive policy alone must not widen the app identity boundary.
      EXECUTE format('CREATE POLICY membership_app_boundary ON memberships.membership AS RESTRICTIVE FOR ALL TO %I USING (user_identity_id::text = NULLIF(current_setting(''innoview.user_identity_id'',true),'''')) WITH CHECK (false)',app);
      EXECUTE format('CREATE POLICY membership_operator_select ON memberships.membership FOR SELECT TO %I USING (true)',operator);
      EXECUTE format('CREATE POLICY membership_operator_insert ON memberships.membership FOR INSERT TO %I WITH CHECK (true)',operator);
      EXECUTE format('CREATE POLICY membership_operator_update ON memberships.membership FOR UPDATE TO %I USING (true) WITH CHECK (true)',operator);
    END $$`);
    await runner.query(
      'ALTER TABLE memberships.membership ENABLE ROW LEVEL SECURITY',
    );
    await runner.query(
      'ALTER TABLE memberships.membership FORCE ROW LEVEL SECURITY',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    // The migration CLI permits reversion only in explicitly disposable DBs.
    await runner.query(
      'ALTER TABLE memberships.membership NO FORCE ROW LEVEL SECURITY',
    );
    await runner.query(
      'ALTER TABLE memberships.membership DISABLE ROW LEVEL SECURITY',
    );
    for (const policy of [
      'membership_app_select',
      'membership_app_boundary',
      'membership_operator_select',
      'membership_operator_insert',
      'membership_operator_update',
    ])
      await runner.query(`DROP POLICY ${policy} ON memberships.membership`);
  }
}
