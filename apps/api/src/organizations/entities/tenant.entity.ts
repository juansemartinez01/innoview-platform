import { Entity, Check, PrimaryGeneratedColumn } from 'typeorm';
import { OrganizationRecord } from './organization-record.js';
@Entity({ schema: 'organizations', name: 'tenant' })
@Check('ck_tenant_name', 'length(btrim(name)) > 0')
@Check('ck_tenant_status', "status IN ('ACTIVE','INACTIVE','ARCHIVED')")
export class Tenant extends OrganizationRecord {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_tenant' })
  id!: string;
}
