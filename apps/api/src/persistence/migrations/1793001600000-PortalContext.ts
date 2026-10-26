import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PortalContext1793001600000 implements MigrationInterface {
  name = 'PortalContext1793001600000';
  async up(runner: QueryRunner): Promise<void> {
    // A navigation preference, deliberately not a FK or a grant of authority.
    // Separate columns prevent token refresh from overwriting the selection.
    await runner.query(`ALTER TABLE portal_sessions.sessions
      ADD COLUMN selected_tenant_id uuid,
      ADD COLUMN context_revision integer NOT NULL DEFAULT 0,
      ADD CONSTRAINT ck_portal_context_revision CHECK(context_revision>=0),
      ADD CONSTRAINT ck_portal_context_session CHECK(selected_tenant_id IS NULL OR kind='session')`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE portal_sessions.sessions DROP CONSTRAINT ck_portal_context_session, DROP CONSTRAINT ck_portal_context_revision, DROP COLUMN context_revision, DROP COLUMN selected_tenant_id',
    );
  }
}
