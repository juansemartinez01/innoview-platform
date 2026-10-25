import { Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import type { OrganizationStatus } from '../organizations.types.js';
// Shared persisted fields for the two real status owners, Tenant and OU.
export abstract class OrganizationRecord {
  @Column('varchar', { length: 200 }) name!: string;
  @Column('varchar', { length: 10, default: 'ACTIVE' })
  status!: OrganizationStatus;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
