import {
  Entity,
  Column,
  PrimaryColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { OrganizationalUnit } from './organizational-unit.entity.js';
import { BusinessGroup } from './business-group.entity.js';
@Entity({ schema: 'organizations', name: 'company' })
@Index('ix_company_parent', ['tenantId', 'businessGroupId'])
export class Company {
  @PrimaryColumn('uuid', {
    name: 'tenant_id',
    primaryKeyConstraintName: 'pk_company',
  })
  tenantId!: string;
  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'pk_company' })
  id!: string;
  @Column({
    type: 'varchar',
    name: 'unit_type',
    length: 10,
    asExpression: "'COMPANY'::character varying",
    generatedType: 'STORED',
    insert: false,
    update: false,
  })
  unitType!: 'COMPANY';
  @ManyToOne(() => OrganizationalUnit, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn([
    {
      name: 'tenant_id',
      referencedColumnName: 'tenantId',
      foreignKeyConstraintName: 'fk_company_unit',
    },
    { name: 'id', referencedColumnName: 'id' },
    { name: 'unit_type', referencedColumnName: 'type' },
  ])
  unit?: OrganizationalUnit;
  @Column('uuid', { name: 'business_group_id' }) businessGroupId!: string;
  @ManyToOne(() => BusinessGroup, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn([
    {
      name: 'tenant_id',
      referencedColumnName: 'tenantId',
      foreignKeyConstraintName: 'fk_company_parent',
    },
    { name: 'business_group_id', referencedColumnName: 'id' },
  ])
  parent?: BusinessGroup;
  @Column('varchar', { name: 'tax_id', length: 80, nullable: true }) taxId!:
    string | null;
}
