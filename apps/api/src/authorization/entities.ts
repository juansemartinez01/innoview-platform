import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

// Migration-owned constraints/RLS. Never generate DDL from these read mappings.
@Entity({ schema: 'authorization', name: 'permission', synchronize: false })
export class Permission {
  @PrimaryColumn('uuid') id!: string;
  @Column('varchar') code!: string;
  @Column({ name: 'owner_module', type: 'varchar' }) ownerModule!: string;
  @Column('varchar') description!: string;
  @Column('varchar') status!: 'ACTIVE' | 'DEPRECATED';
  @Column({ name: 'replaced_by', type: 'uuid', nullable: true }) replacedBy!:
    string | null;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
@Entity({ schema: 'authorization', name: 'role', synchronize: false })
export class Role {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column('varchar') name!: string;
  @Column('varchar') description!: string;
  @Column('varchar') status!: 'ACTIVE' | 'INACTIVE';
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
abstract class GrantRecord {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'role_id', type: 'uuid' }) roleId!: string;
  @Column('varchar') status!: 'ACTIVE' | 'REVOKED';
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
  @Column({ name: 'revocation_reason', type: 'text', nullable: true })
  revocationReason!: string | null;
}
@Entity({
  schema: 'authorization',
  name: 'role_permission',
  synchronize: false,
})
export class RolePermission extends GrantRecord {
  @Column({ name: 'permission_id', type: 'uuid' }) permissionId!: string;
}
@Entity({
  schema: 'authorization',
  name: 'role_assignment',
  synchronize: false,
})
export class RoleAssignment extends GrantRecord {
  @Column({ name: 'membership_id', type: 'uuid' }) membershipId!: string;
  @Column({ name: 'scope_unit_id', type: 'uuid' }) scopeUnitId!: string;
  @Column({ name: 'scope_type', type: 'varchar' }) scopeType!:
    'GROUP' | 'COMPANY' | 'BRANCH';
}
@Entity({
  schema: 'authorization',
  name: 'catalog_version',
  synchronize: false,
})
export class CatalogVersion {
  @PrimaryColumn('boolean') singleton!: boolean;
  @Column('bigint') revision!: string;
}
@Entity({
  schema: 'authorization',
  name: 'tenant_revision',
  synchronize: false,
})
export class TenantAuthorizationRevision {
  @PrimaryColumn({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column('bigint') revision!: string;
}
@Entity({ schema: 'authorization', name: 'operation', synchronize: false })
export class AuthorizationOperationRecord {
  @PrimaryColumn({ name: 'request_id', type: 'uuid' }) requestId!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'operation_type', type: 'text' }) operationType!: string;
  @Column('text') fingerprint!: string;
  @Column({ name: 'fingerprint_version', type: 'smallint' })
  fingerprintVersion!: number;
  @Column('text') actor!: string;
  @Column({ name: 'actor_type', type: 'text' }) actorType!: string;
  @Column({ name: 'actor_membership_id', type: 'uuid', nullable: true })
  actorMembershipId!: string | null;
  @Column({ name: 'actor_user_identity_id', type: 'uuid', nullable: true })
  actorUserIdentityId!: string | null;
  @Column('text') reason!: string;
  @Column({ name: 'technical_source', type: 'text' }) technicalSource!: string;
  @Column({ type: 'jsonb', nullable: true }) result!: unknown;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
@Entity({ schema: 'authorization', name: 'audit_event', synchronize: false })
export class AuthorizationAuditEvent {
  @PrimaryColumn('uuid') id!: string;
  @Column({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ name: 'operation_request_id', type: 'uuid' })
  operationRequestId!: string;
  @Column({ name: 'record_type', type: 'text' }) recordType!: string;
  @Column({ name: 'record_id', type: 'uuid' }) recordId!: string;
  @Column('text') action!: string;
  @Column({ name: 'old_status', type: 'text', nullable: true }) oldStatus!:
    string | null;
  @Column({ name: 'new_status', type: 'text' }) newStatus!: string;
  @Column('text') actor!: string;
  @Column({ name: 'actor_type', type: 'text' }) actorType!: string;
  @Column({ name: 'actor_membership_id', type: 'uuid', nullable: true })
  actorMembershipId!: string | null;
  @Column({ name: 'actor_user_identity_id', type: 'uuid', nullable: true })
  actorUserIdentityId!: string | null;
  @Column('text') reason!: string;
  @Column({ name: 'technical_source', type: 'text' }) technicalSource!: string;
  @Column({ name: 'db_actor', type: 'text' }) dbActor!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
export const authorizationEntities = [
  Permission,
  Role,
  RolePermission,
  RoleAssignment,
  CatalogVersion,
  TenantAuthorizationRevision,
  AuthorizationOperationRecord,
  AuthorizationAuditEvent,
];
