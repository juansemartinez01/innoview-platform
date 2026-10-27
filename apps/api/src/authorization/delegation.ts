import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Header,
  Headers,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  AuthenticationGuard,
  isVerifiedPrincipal,
  type IdentityRequest,
  type Principal,
} from '../authentication/authentication.module.js';
import { IdentityService } from '../identity/identity.module.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { canonicalUuid, securityEvent } from '../security/security-events.js';
import { authorizationFingerprint } from './fingerprint.js';
import { CURRENT_FINGERPRINT_VERSION } from '../operations/fingerprint.js';
import {
  establishOperationLocals,
  transientFailure,
  TrustedOperationTransientError,
} from '../operations/operation-context.js';

export const AUTHORIZATION_DELEGATION_SOURCE = Symbol(
  'authorization.delegation-source',
);
export interface DelegatedAssignment {
  requestId: string;
  membershipId: string;
  roleId: string;
  scopeType: 'GROUP' | 'COMPANY' | 'BRANCH';
  scopeUnitId: string;
  reason: string;
}
// A separate contract: technicalOperation continues to reject USER_IDENTITY.
export function delegatedOperation(
  identityId: string,
  membershipId: string,
  input: DelegatedAssignment,
) {
  if (
    !canonicalUuid(identityId) ||
    !canonicalUuid(membershipId) ||
    !canonicalUuid(input.requestId) ||
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.length > 500 ||
    /\p{Cc}/u.test(input.reason)
  )
    throw new NotFoundException('Resource unavailable');
  return Object.freeze({
    actor: identityId,
    actorType: 'USER_IDENTITY' as const,
    actorMembershipId: membershipId,
    actorUserIdentityId: identityId,
    reason: input.reason.trim(),
    requestId: input.requestId,
  });
}
function inputContract(body: unknown): DelegatedAssignment {
  const keys = [
    'requestId',
    'membershipId',
    'roleId',
    'scopeType',
    'scopeUnitId',
    'reason',
  ];
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(body, k))
  )
    throw new NotFoundException('Resource unavailable');
  const value = body as DelegatedAssignment;
  if (
    ![
      value.requestId,
      value.membershipId,
      value.roleId,
      value.scopeUnitId,
    ].every(canonicalUuid) ||
    !['GROUP', 'COMPANY', 'BRANCH'].includes(value.scopeType)
  )
    throw new NotFoundException('Resource unavailable');
  return { ...value };
}
@Injectable()
export class DelegatedAssignments implements OnModuleDestroy {
  constructor(
    @Inject(AUTHORIZATION_DELEGATION_SOURCE)
    private readonly source: DataSource,
  ) {}
  async onModuleDestroy() {
    if (this.source.isInitialized) await this.source.destroy();
  }
  async assign(principal: Principal, tenantId: string, body: unknown) {
    if (!isVerifiedPrincipal(principal) || !canonicalUuid(tenantId))
      throw new NotFoundException('Resource unavailable');
    const input = inputContract(body);
    try {
      return await this.source.transaction(
        'READ COMMITTED',
        async (manager) => {
          if (
            manager.connection !== this.source ||
            !manager.queryRunner?.isTransactionActive
          )
            throw new Error('Delegated transaction required');
          const [role] = await manager.query<{ valid: boolean }[]>(
            "SELECT shobj_description(oid,'pg_authid')='innoview:'||current_database()||':authorization_delegation' AS valid FROM pg_roles WHERE rolname=current_user",
          );
          if (!role?.valid) throw new Error('Delegated role required');
          await manager.query(
            "SELECT set_config('innoview.oidc_issuer',$1,true),set_config('innoview.oidc_subject',$2,true),set_config('innoview.tenant_id',$3,true),set_config('innoview.user_identity_id','',true),set_config('innoview.delegation_target_membership',$4,true)",
            [principal.issuer, principal.subject, tenantId, input.membershipId],
          );
          const identityId = await new IdentityService(
            this.source,
          ).findReference(principal, manager);
          if (!identityId) throw new NotFoundException('Resource unavailable');
          await manager.query(
            "SELECT set_config('innoview.user_identity_id',$1,true)",
            [identityId],
          );
          const members = new MembershipsService(this.source);
          const actor = await members.authorizationMembership(
            tenantId,
            identityId,
            manager,
          );
          if (!actor) throw new NotFoundException('Resource unavailable');
          const op = delegatedOperation(identityId, actor.id, input);
          // Shared establishment, distinct human contract and independent credential.
          await establishOperationLocals(
            manager,
            'authorization',
            op,
            tenantId,
          );
          await manager.query(
            "SELECT set_config('innoview.delegation_actor_membership',$1,true)",
            [actor.id],
          );
          const revision = await manager.query<{ revision: string }[]>(
            'SELECT revision FROM "authorization".tenant_revision WHERE tenant_id=$1 FOR UPDATE',
            [tenantId],
          );
          if (!revision.length)
            throw new NotFoundException('Resource unavailable');
          const args = {
            tenantId,
            actorIdentityId: identityId,
            actorMembershipId: actor.id,
            membershipId: input.membershipId,
            roleId: input.roleId,
            scope: { type: input.scopeType, unitId: input.scopeUnitId },
          };
          const previous = await manager.query<
            {
              fingerprint: string;
              fingerprint_version: number;
              actor: string;
              reason: string;
              result: unknown;
              completed_at: Date | null;
            }[]
          >(
            'SELECT fingerprint,fingerprint_version,actor,reason,result,completed_at FROM "authorization".operation WHERE request_id=$1',
            [op.requestId],
          );
          if (
            previous[0] &&
            (previous[0].fingerprint !==
              authorizationFingerprint(
                previous[0].fingerprint_version,
                'DELEGATED_ASSIGN',
                args,
              ) ||
              previous[0].actor !== op.actor ||
              previous[0].reason !== op.reason)
          )
            throw new ConflictException('Request conflict');
          const target = await members.delegationTargetReference(
            tenantId,
            input.membershipId,
            manager,
          );
          const units = await manager.query<{ id: string }[]>(
            new OrganizationsService(this.source)
              .authorizationUnitsSql(true)
              .replaceAll('$5', '$2')
              .replaceAll('$6', '$3'),
            [tenantId, input.scopeType, input.scopeUnitId],
          );
          const targetRole = await manager.query<{ id: string }[]>(
            'SELECT id FROM "authorization".role WHERE tenant_id=$1 AND id=$2 AND status=\'ACTIVE\'',
            [tenantId, input.roleId],
          );
          if (!target || !units.length || !targetRole.length)
            throw new NotFoundException('Resource unavailable');
          const [authority] = await manager.query<{ allowed: boolean }[]>(
            'SELECT "authorization".delegation_allowed($1,$2,$3,$4,$5,$6,$7) AS allowed',
            [
              tenantId,
              actor.id,
              identityId,
              input.roleId,
              input.scopeType,
              input.scopeUnitId,
              input.membershipId,
            ],
          );
          if (!authority?.allowed)
            throw new ForbiddenException('Access denied');
          if (previous[0]) {
            if (!previous[0].completed_at || !previous[0].result)
              throw new Error('Incomplete operation');
            securityEvent('TRUSTED_OPERATION_REPLAY', op.requestId);
            return previous[0].result;
          }
          await manager.query(
            'SET CONSTRAINTS "authorization".operation_tenant_id_fkey DEFERRED',
          );
          const inserted = await manager.query<{ request_id: string }[]>(
            `INSERT INTO "authorization".operation(request_id,tenant_id,operation_type,fingerprint,fingerprint_version,actor,actor_type,reason,technical_source,actor_membership_id,actor_user_identity_id)
          VALUES($1,$2,'DELEGATED_ASSIGN',$3,$4,$5::text,'USER_IDENTITY',$6,'api:delegated-assignment',$7,$5::uuid) ON CONFLICT(request_id) DO NOTHING RETURNING request_id`,
            [
              op.requestId,
              tenantId,
              authorizationFingerprint(
                CURRENT_FINGERPRINT_VERSION,
                'DELEGATED_ASSIGN',
                args,
              ),
              CURRENT_FINGERPRINT_VERSION,
              identityId,
              op.reason,
              actor.id,
            ],
          );
          if (!inserted.length) throw new ConflictException('Request conflict');
          const [assignment] = await manager.query<
            { id: string; status: string }[]
          >(
            'INSERT INTO "authorization".role_assignment(tenant_id,membership_id,role_id,scope_type,scope_unit_id) VALUES($1,$2,$3,$4,$5) RETURNING id,status',
            [
              tenantId,
              input.membershipId,
              input.roleId,
              input.scopeType,
              input.scopeUnitId,
            ],
          );
          await manager.query(
            'UPDATE "authorization".operation SET result=$2::jsonb,completed_at=clock_timestamp() WHERE request_id=$1',
            [op.requestId, JSON.stringify(assignment)],
          );
          return assignment;
        },
      );
    } catch (error) {
      const transient = transientFailure(error);
      if (transient) throw new TrustedOperationTransientError(transient);
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505' &&
        'constraint' in error &&
        error.constraint === 'uq_active_role_assignment'
      )
        throw new ConflictException('Request conflict');
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '42501'
      )
        throw new ForbiddenException('Access denied');
      throw error;
    }
  }
}
@Controller('admin/role-assignments')
export class DelegatedAssignmentsController {
  constructor(private readonly assignments: DelegatedAssignments) {}
  @Post()
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthenticationGuard)
  assign(
    @Req() request: IdentityRequest,
    @Headers('x-tenant-id') tenantId: string,
    @Body() body: unknown,
  ) {
    return this.assignments.assign(request.identity!, tenantId, body);
  }
}
