import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  isVerifiedPrincipal,
  type Principal,
} from '../authentication/authentication.module.js';
import { TenantReadTransactions } from '../context/context.module.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import {
  canonicalUuid,
  deprecatedPermissionEvent,
} from '../security/security-events.js';
import { permissionCode } from './authorization.service.js';
import { accessQueries } from './access.queries.js';
import type {
  AuthorizationAccessV1,
  AuthorizationContext,
  AuthorizationDecision,
  PermissionSummary,
  Scope,
} from './access.contract.js';

const issued = Symbol('authorization.current-transaction');
interface State {
  source: DataSource;
  membershipId: string;
  active: boolean;
  deprecated: boolean;
}
type IssuedContext = AuthorizationContext & { [issued]: State };
@Injectable()
export class AuthorizationReads {
  constructor(
    @Inject(DataSource) private readonly source: DataSource,
    private readonly tenants: TenantReadTransactions,
    private readonly memberships: MembershipsService,
  ) {}
  async read<T>(
    principal: Principal,
    tenant: string,
    action: (context: AuthorizationContext) => Promise<T> | T,
  ): Promise<T> {
    if (!isVerifiedPrincipal(principal) || !canonicalUuid(tenant))
      throw new NotFoundException('Resource unavailable');
    return this.tenants.read(
      principal,
      tenant,
      async (manager, _option, identityId) => {
        const membership = await this.memberships.authorizationMembership(
          tenant,
          identityId,
          manager,
        );
        if (!membership) throw new NotFoundException('Resource unavailable');
        const state: State = {
          source: this.source,
          membershipId: membership.id,
          active: true,
          deprecated: false,
        };
        const context = Object.freeze(
          Object.defineProperties(
            { identityId, tenantId: tenant },
            { [issued]: { value: state }, manager: { value: manager } },
          ),
        ) as IssuedContext;
        try {
          if (!(await validContext(context, this.source)))
            throw new NotFoundException('Resource unavailable');
          return await action(context);
        } finally {
          state.active = false;
        }
      },
    );
  }
}
async function validContext(context: AuthorizationContext, source: DataSource) {
  const state = (context as IssuedContext | undefined)?.[issued];
  const manager = context?.manager;
  if (
    !state?.active ||
    state.source !== source ||
    manager?.connection !== source ||
    !manager.queryRunner?.isTransactionActive ||
    !canonicalUuid(context.identityId) ||
    !canonicalUuid(context.tenantId)
  )
    return false;
  const [valid] = await manager.query<{ valid: boolean }[]>(
    `SELECT current_setting('transaction_isolation')='repeatable read' AND current_setting('transaction_read_only')='on' AND current_setting('innoview.user_identity_id',true)=$1 AND current_setting('innoview.tenant_id',true)=$2 AND shobj_description(oid,'pg_authid')='innoview:'||current_database()||':app' AS valid FROM pg_roles WHERE rolname=current_user`,
    [context.identityId, context.tenantId],
  );
  return valid?.valid === true;
}
@Injectable()
export class AuthorizationEvaluator implements AuthorizationAccessV1 {
  readonly queries: ReturnType<typeof accessQueries>;
  constructor(
    @Inject(DataSource) private readonly source: DataSource,
    members: MembershipsService,
    orgs: OrganizationsService,
  ) {
    this.queries = accessQueries(members, orgs);
  }
  private parameters(c: AuthorizationContext) {
    return [
      c.tenantId,
      (c as IssuedContext)[issued].membershipId,
      c.identityId,
    ];
  }
  private deprecation(c: AuthorizationContext, deprecated: boolean) {
    const state = (c as IssuedContext)[issued];
    if (deprecated && !state.deprecated) {
      state.deprecated = true;
      deprecatedPermissionEvent();
    }
  }
  async can(
    c: AuthorizationContext,
    permission: string,
    scope: Scope,
  ): Promise<AuthorizationDecision> {
    if (!(await validContext(c, this.source)))
      return { allowed: false, reason: 'UNAVAILABLE_CONTEXT' };
    if (!permissionCode(permission))
      return { allowed: false, reason: 'UNKNOWN_PERMISSION' };
    if (
      !scope ||
      !['GROUP', 'COMPANY', 'BRANCH'].includes(scope.type) ||
      !canonicalUuid(scope.unitId)
    )
      return { allowed: false, reason: 'NO_GRANT' };
    const [row] = await c.manager.query<{ status: string; granted: boolean }[]>(
      this.queries.can,
      [...this.parameters(c), permission, scope.type, scope.unitId],
    );
    if (!row) return { allowed: false, reason: 'UNKNOWN_PERMISSION' };
    this.deprecation(c, row.status === 'DEPRECATED' && row.granted);
    return row.status === 'ACTIVE' && row.granted
      ? { allowed: true }
      : { allowed: false, reason: 'NO_GRANT' };
  }
  async permissionsFor(c: AuthorizationContext): Promise<PermissionSummary[]> {
    if (!(await validContext(c, this.source))) return [];
    const [row] = await c.manager.query<
      { values: PermissionSummary[]; deprecated: boolean }[]
    >(this.queries.permissions, this.parameters(c));
    this.deprecation(c, row.deprecated);
    return row.values.sort((a, b) => a.code.localeCompare(b.code));
  }
  async scopesFor(
    c: AuthorizationContext,
    permission: string,
  ): Promise<Scope[]> {
    if (!(await validContext(c, this.source)) || !permissionCode(permission))
      return [];
    const [row] = await c.manager.query<
      { values: Scope[]; deprecated: boolean }[]
    >(this.queries.scopes, [...this.parameters(c), permission]);
    this.deprecation(c, row.deprecated);
    return row.values.sort(
      (a, b) =>
        a.type.localeCompare(b.type) || a.unitId.localeCompare(b.unitId),
    );
  }
}
