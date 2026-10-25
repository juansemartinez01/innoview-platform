import {
  Entity,
  Column,
  PrimaryColumn,
  Unique,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { OrganizationalUnit } from './organizational-unit.entity.js';
@Entity({ schema: 'organizations', name: 'business_group' })
@Unique('uq_group_tenant', ['tenantId'])
export class BusinessGroup {
  @PrimaryColumn('uuid', {
    name: 'tenant_id',
    primaryKeyConstraintName: 'pk_business_group',
  })
  tenantId!: string;
  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'pk_business_group' })
  id!: string;
  @Column({
    type: 'varchar',
    name: 'unit_type',
    length: 10,
    asExpression: "'GROUP'::character varying",
    generatedType: 'STORED',
    insert: false,
    update: false,
  })
  unitType!: 'GROUP';
  @ManyToOne(() => OrganizationalUnit, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn([
    {
      name: 'tenant_id',
      referencedColumnName: 'tenantId',
      foreignKeyConstraintName: 'fk_business_group_unit',
    },
    { name: 'id', referencedColumnName: 'id' },
    { name: 'unit_type', referencedColumnName: 'type' },
  ])
  unit?: OrganizationalUnit;
}
