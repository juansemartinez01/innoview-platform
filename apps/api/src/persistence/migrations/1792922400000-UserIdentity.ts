import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UserIdentity1792922400000 implements MigrationInterface {
  name = 'UserIdentity1792922400000';

  async up(runner: QueryRunner): Promise<void> {
    // Bootstrap provisions the empty schema: the migrator deliberately lacks
    // CREATE on the database and must own only explicitly managed schemas.
    const [schema] = (await runner.query(
      `SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_namespace WHERE nspname='identity'`,
    )) as { owned: boolean }[];
    if (!schema?.owned)
      throw new Error('Provision the managed identity schema before migrating');
    await runner.query(`CREATE TABLE identity.user_identity (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      issuer varchar(2048) NOT NULL,
      external_subject varchar(255) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_user_identity PRIMARY KEY (id),
      CONSTRAINT uq_user_identity_issuer_subject UNIQUE (issuer, external_subject),
      CONSTRAINT ck_user_identity_nonempty CHECK (length(issuer)>0 AND length(external_subject)>0)
    )`);
  }

  async down(runner: QueryRunner): Promise<void> {
    // No CASCADE: future dependent objects must prevent an accidental revert.
    await runner.query('DROP TABLE identity.user_identity');
  }
}
