import type { MigrationInterface, QueryRunner } from 'typeorm';

export class BffSessions1792915200000 implements MigrationInterface {
  name = 'BffSessions1792915200000';

  async up(runner: QueryRunner): Promise<void> {
    for (const schema of ['portal_sessions', 'control_sessions']) {
      await runner.query(`CREATE TABLE ${schema}.sessions (
        id_hash text PRIMARY KEY,
        kind text NOT NULL CHECK (kind IN ('anonymous','login','session','logout')),
        encrypted text NOT NULL,
        expires_at timestamptz NOT NULL,
        idle_until timestamptz NOT NULL,
        access_until timestamptz,
        lease_id uuid,
        lease_until timestamptz,
        version integer NOT NULL DEFAULT 0
      )`);
      await runner.query(`CREATE INDEX ON ${schema}.sessions (expires_at)`);
    }
  }

  async down(runner: QueryRunner): Promise<void> {
    for (const schema of ['portal_sessions', 'control_sessions'])
      await runner.query(`DROP TABLE ${schema}.sessions`);
  }
}
