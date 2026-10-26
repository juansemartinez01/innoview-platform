import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { Membership } from './membership.entity.js';
import { MembershipAuditEvent } from './audit-event.entity.js';

export interface MembershipOperation {
  actor: string;
  reason: string;
  requestId: string;
}
export class MembershipOperationError extends Error {
  constructor(readonly code: string) {
    super(`Membership operation rejected: ${code}`);
  }
}
function uuid(value: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new MembershipOperationError('INVALID_REFERENCE');
  return value.toLowerCase();
}
function text(value: string, max: number): string {
  const result = value.trim();
  if (!result || result.length > max || /\p{Cc}/u.test(result))
    throw new MembershipOperationError('INVALID_CONTEXT');
  return result;
}

@Injectable()
export class MembershipsService {
  constructor(@Inject(DataSource) private readonly source: DataSource) {}

  async activeTenantReferences(
    userIdentityId: string,
    manager: EntityManager,
  ): Promise<string[]> {
    if (
      manager.connection !== this.source ||
      !manager.queryRunner?.isTransactionActive
    )
      throw new Error('Active local transaction required');
    const rows = await manager.getRepository(Membership).find({
      select: { tenantId: true },
      where: { userIdentityId: uuid(userIdentityId), status: 'ACTIVE' },
    });
    return rows.map((row) => row.tenantId);
  }

  listForIdentity(userIdentityId: string): Promise<Membership[]> {
    return this.source.getRepository(Membership).find({
      where: { userIdentityId: uuid(userIdentityId) },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }
  listActiveForIdentity(userIdentityId: string): Promise<Membership[]> {
    return this.source.getRepository(Membership).find({
      where: { userIdentityId: uuid(userIdentityId), status: 'ACTIVE' },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }
  async isActive(tenantId: string, userIdentityId: string): Promise<boolean> {
    // Fresh authoritative DB read; neither JWT claims nor a frontend tenant ID
    // substitute for this check. This alone does not authorize business data.
    return this.source.getRepository(Membership).existsBy({
      tenantId: uuid(tenantId),
      userIdentityId: uuid(userIdentityId),
      status: 'ACTIVE',
    });
  }
  register(
    tenantId: string,
    userIdentityId: string,
    operation: MembershipOperation,
  ) {
    return this.write('REGISTER', tenantId, userIdentityId, operation);
  }
  bootstrapFirst(
    tenantId: string,
    userIdentityId: string,
    operation: MembershipOperation,
  ) {
    return this.write('BOOTSTRAP', tenantId, userIdentityId, operation);
  }
  revoke(
    tenantId: string,
    userIdentityId: string,
    operation: MembershipOperation,
  ) {
    return this.write('REVOKE', tenantId, userIdentityId, operation);
  }

  private async write(
    action: 'REGISTER' | 'BOOTSTRAP' | 'REVOKE',
    tenantId: string,
    userIdentityId: string,
    operation: MembershipOperation,
  ) {
    tenantId = uuid(tenantId);
    userIdentityId = uuid(userIdentityId);
    const requestId = uuid(operation.requestId);
    const actor = text(operation.actor, 200);
    const reason = text(operation.reason, 500);
    const source = action === 'BOOTSTRAP' ? 'BOOTSTRAP' : 'TRUSTED';
    const eventType = action === 'REVOKE' ? 'REVOKED' : 'CREATED';
    try {
      return await this.source.transaction(async (manager: EntityManager) => {
        const [role] = await manager.query<{ marker: string }[]>(
          "SELECT shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=current_user",
        );
        if (
          role?.marker !==
          `innoview:${String(this.source.options.database)}:membership`
        )
          throw new MembershipOperationError('WRITE_NOT_ALLOWED');
        await manager.query(
          "SELECT set_config('innoview.membership_actor',$1,true),set_config('innoview.membership_reason',$2,true),set_config('innoview.membership_source',$3,true),set_config('innoview.membership_request',$4,true)",
          [actor, reason, source, requestId],
        );
        // Shared lock order with DB guards. No HTTP or cross-module private reads.
        await manager.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('memberships:request:'||$1,0))",
          [requestId],
        );
        await manager.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('memberships:tenant:'||$1,0))",
          [tenantId],
        );
        const audit = manager.getRepository(MembershipAuditEvent);
        const previous = await audit.findOneBy({ requestId });
        const repository = manager.getRepository(Membership);
        let membership = await repository.findOneBy({
          tenantId,
          userIdentityId,
        });
        if (
          previous &&
          (previous.tenantId !== tenantId ||
            previous.membershipId !== membership?.id ||
            previous.source !== source ||
            previous.eventType !== eventType)
        )
          throw new MembershipOperationError('REQUEST_CONFLICT');
        if (membership) {
          const creation = await audit.findOneByOrFail({
            membershipId: membership.id,
            eventType: 'CREATED',
          });
          if (action === 'BOOTSTRAP' && creation.source !== 'BOOTSTRAP')
            throw new MembershipOperationError('BOOTSTRAP_ALREADY_COMPLETED');
          if (action === 'REGISTER' && membership.status === 'REVOKED')
            throw new MembershipOperationError('REVOKED_TERMINAL');
          if (action !== 'REVOKE' || membership.status === 'REVOKED') {
            const event =
              action === 'REVOKE'
                ? await audit.findOneByOrFail({
                    membershipId: membership.id,
                    eventType: 'REVOKED',
                  })
                : creation;
            return { membership, changed: false, auditEventId: event.id };
          }
          await repository.update({ id: membership.id }, { status: 'REVOKED' });
        } else {
          if (action === 'REVOKE')
            throw new MembershipOperationError('NOT_FOUND');
          if (
            action === 'BOOTSTRAP' &&
            (await repository.existsBy({ tenantId }))
          )
            throw new MembershipOperationError('BOOTSTRAP_ALREADY_COMPLETED');
          await repository.insert({ tenantId, userIdentityId });
        }
        membership = await repository.findOneByOrFail({
          tenantId,
          userIdentityId,
        });
        const event = await audit.findOneByOrFail({ requestId });
        return { membership, changed: true, auditEventId: event.id };
      });
    } catch (error) {
      if (error instanceof MembershipOperationError) throw error;
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23503'
      )
        throw new MembershipOperationError('INVALID_REFERENCE');
      // Never return query text, parameters, secrets or PostgreSQL diagnostics.
      throw new MembershipOperationError('PERSISTENCE_UNAVAILABLE');
    }
  }
}
