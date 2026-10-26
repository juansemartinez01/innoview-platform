import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Membership } from './membership.entity.js';

@Entity({ schema: 'memberships', name: 'audit_event' })
@Unique('uq_membership_audit_request', ['requestId'])
@Unique('uq_membership_audit_transition', ['membershipId', 'eventType'])
@Check(
  'ck_membership_audit_type',
  "event_type IN ('CREATED','REVOKED') AND source IN ('BOOTSTRAP','TRUSTED')",
)
@Check(
  'ck_membership_audit_context',
  'length(btrim(actor))>0 AND length(btrim(reason))>0 AND length(btrim(db_actor))>0',
)
export class MembershipAuditEvent {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_membership_audit',
  })
  id!: string;
  @Column('uuid', { name: 'tenant_id' }) tenantId!: string;
  @Column('uuid', { name: 'membership_id' }) membershipId!: string;
  @Column('varchar', { name: 'event_type', length: 7 }) eventType!:
    'CREATED' | 'REVOKED';
  @Column('varchar', { length: 9 }) source!: 'BOOTSTRAP' | 'TRUSTED';
  @Column('varchar', { length: 200 }) actor!: string;
  @Column('varchar', { length: 500 }) reason!: string;
  @Column('uuid', { name: 'request_id' }) requestId!: string;
  @Column('varchar', { name: 'db_actor', length: 63 }) dbActor!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
  @ManyToOne(() => Membership, { onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'tenant_id',
      referencedColumnName: 'tenantId',
      foreignKeyConstraintName: 'fk_membership_audit_membership',
    },
    {
      name: 'membership_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_membership_audit_membership',
    },
  ])
  membership!: Membership;
}
