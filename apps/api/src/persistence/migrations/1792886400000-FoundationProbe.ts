import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FoundationProbe1792886400000 implements MigrationInterface {
  name = 'FoundationProbe1792886400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE foundation.persistence_probe (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      value text NOT NULL
    )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE foundation.persistence_probe');
  }
}
