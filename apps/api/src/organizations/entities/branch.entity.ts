import {
  Entity,
  Column,
  PrimaryColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { OrganizationalUnit } from './organizational-unit.entity.js';
import { Company } from './company.entity.js';
@Entity({ schema: 'organizations', name: 'branch' })
@Index('ix_branch_parent', ['tenantId', 'companyId'])
export class Branch {
  @PrimaryColumn('uuid', {
    name: 'tenant_id',
    primaryKeyConstraintName: 'pk_branch',
  })
  tenantId!: string;
  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'pk_branch' }) id!: string;
  @Column({
    type: 'varchar',
    name: 'unit_type',
    length: 10,
    asExpression: "'BRANCH'::character varying",
    generatedType: 'STORED',
    insert: false,
    update: false,
  })
  unitType!: 'BRANCH';
  @ManyToOne(() => OrganizationalUnit, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn([
    {
      name: 'tenant_id',
      referencedColumnName: 'tenantId',
      foreignKeyConstraintName: 'fk_branch_unit',
    },
    { name: 'id', referencedColumnName: 'id' },
    { name: 'unit_type', referencedColumnName: 'type' },
  ])
  unit?: OrganizationalUnit;
  @Column('uuid', { name: 'company_id' }) companyId!: string;
  @ManyToOne(() => Company, {
    nullable: false,
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  })
  @JoinColumn([
    {
      name: 'tenant_id',
      referencedColumnName: 'tenantId',
      foreignKeyConstraintName: 'fk_branch_parent',
    },
    { name: 'company_id', referencedColumnName: 'id' },
  ])
  parent?: Company;
}
