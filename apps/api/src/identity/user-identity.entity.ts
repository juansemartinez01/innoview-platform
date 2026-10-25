import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Check(
  'ck_user_identity_nonempty',
  'length(issuer)>0 AND length(external_subject)>0',
)
@Entity({ schema: 'identity', name: 'user_identity' })
@Unique('uq_user_identity_issuer_subject', ['issuer', 'externalSubject'])
export class UserIdentity {
  // PostgreSQL 18 has gen_random_uuid built in; no UUID extension privileges.
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'pk_user_identity',
  })
  id!: string;

  @Column('varchar', { length: 2048 })
  issuer!: string;

  @Column('varchar', { name: 'external_subject', length: 255 })
  externalSubject!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
