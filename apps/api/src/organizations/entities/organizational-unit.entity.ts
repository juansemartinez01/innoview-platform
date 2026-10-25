import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Check,
  Unique,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { OrganizationRecord } from './organization-record.js';
import { Tenant } from './tenant.entity.js';
import type { OrganizationKind } from '../organizations.types.js';
@Entity({ schema: 'organizations', name: 'organizational_unit' })
@Unique('uq_unit_tenant_id_type', ['tenantId', 'id', 'type'])
@Unique('uq_unit_tenant_id', ['tenantId', 'id'])
@Check('ck_unit_name', 'length(btrim(name)) > 0')
@Check('ck_unit_status', "status IN ('ACTIVE','INACTIVE','ARCHIVED')")
@Check('ck_unit_type', "type IN ('GROUP','COMPANY','BRANCH')")
export class OrganizationalUnit extends OrganizationRecord {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_unit' })
  id!: string;
  @Column('uuid', { name: 'tenant_id' }) tenantId!: string;
  @Column('varchar', { length: 10 }) type!: OrganizationKind;
  @ManyToOne(() => Tenant, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn({
    name: 'tenant_id',
    referencedColumnName: 'id',
    foreignKeyConstraintName: 'fk_unit_tenant',
  })
  tenant?: Tenant;
}
