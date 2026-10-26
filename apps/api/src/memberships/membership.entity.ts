import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Tenant } from '../organizations/entities/tenant.entity.js';
import { UserIdentity } from '../identity/user-identity.entity.js';

@Entity({ schema: 'memberships', name: 'membership' })
@Index('ix_membership_identity_status', ['userIdentityId', 'status'])
@Unique('uq_membership_tenant_identity', ['tenantId', 'userIdentityId'])
@Unique('uq_membership_tenant_id', ['tenantId', 'id'])
@Check(
  'ck_membership_state',
  "(status='ACTIVE' AND revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL) OR (status='REVOKED' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_reason IS NOT NULL AND length(btrim(revoked_by))>0 AND length(btrim(revoked_reason))>0)",
)
export class Membership {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'pk_membership' })
  id!: string;
  @Column('uuid', { name: 'tenant_id' }) tenantId!: string;
  @Column('uuid', { name: 'user_identity_id' }) userIdentityId!: string;
  @Column('varchar', { length: 10, default: 'ACTIVE' }) status!:
    'ACTIVE' | 'REVOKED';
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
  @Column('timestamptz', { name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;
  @Column('varchar', { name: 'revoked_by', length: 200, nullable: true })
  revokedBy!: string | null;
  @Column('varchar', { name: 'revoked_reason', length: 500, nullable: true })
  revokedReason!: string | null;

  // Explicit stable reference contracts, not permission to query private data.
  @ManyToOne(() => Tenant, { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
  @JoinColumn({
    name: 'tenant_id',
    foreignKeyConstraintName: 'fk_membership_tenant',
  })
  tenant!: Tenant;
  @ManyToOne(() => UserIdentity, { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
  @JoinColumn({
    name: 'user_identity_id',
    foreignKeyConstraintName: 'fk_membership_identity',
  })
  userIdentity!: UserIdentity;
}
