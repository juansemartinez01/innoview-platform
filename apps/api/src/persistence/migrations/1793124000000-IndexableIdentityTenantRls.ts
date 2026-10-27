import type { MigrationInterface, QueryRunner } from 'typeorm';

function contextUuid(setting: 'user_identity_id' | 'tenant_id') {
  return `CASE WHEN current_setting('innoview.${setting}',true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN current_setting('innoview.${setting}',true)::uuid ELSE NULL::uuid END`;
}
export class IndexableIdentityTenantRls1793124000000 implements MigrationInterface {
  name = 'IndexableIdentityTenantRls1793124000000';
  private async change(r: QueryRunner, indexable: boolean) {
    const identity = (column: string) =>
      indexable
        ? `${column} = ${contextUuid('user_identity_id')}`
        : `${column}::text = NULLIF(current_setting('innoview.user_identity_id',true),'')`;
    const tenant = (column: string) =>
      indexable
        ? `${column} = ${contextUuid('tenant_id')}`
        : `${column}::text = NULLIF(current_setting('innoview.tenant_id',true),'')`;
    for (const [schema, table, select, boundary, predicate] of [
      [
        'memberships',
        'membership',
        'membership_app_select',
        'membership_app_boundary',
        identity('user_identity_id'),
      ],
      [
        'organizations',
        'tenant_directory',
        'app_select',
        'app_boundary',
        `available AND EXISTS(SELECT 1 FROM memberships.membership m WHERE m.tenant_id=tenant_directory.tenant_id AND m.status='ACTIVE' AND ${identity('m.user_identity_id')})`,
      ],
      ...[
        'tenant',
        'business_group',
        'organizational_unit',
        'company',
        'branch',
      ].map((table) => [
        'organizations',
        table,
        'app_select',
        'app_boundary',
        `${tenant(table === 'tenant' ? 'id' : 'tenant_id')} AND EXISTS(SELECT 1 FROM organizations.tenant_directory d WHERE d.tenant_id=${table}.${table === 'tenant' ? 'id' : 'tenant_id'} AND d.available)`,
      ]),
    ]) {
      await r.query(
        `ALTER POLICY ${select} ON ${schema}.${table} USING(${predicate})`,
      );
      await r.query(
        `ALTER POLICY ${boundary} ON ${schema}.${table} USING(${predicate}) WITH CHECK(false)`,
      );
    }
  }
  async up(r: QueryRunner) {
    await this.change(r, true);
  }
  async down(r: QueryRunner) {
    await this.change(r, false);
  }
}
