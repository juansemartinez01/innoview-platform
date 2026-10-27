import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Injectable,
  NotFoundException,
  Req,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AuthenticationGuard,
  type IdentityRequest,
} from '../authentication/authentication.module.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { AuthorizationReads } from './access.runtime.js';
import {
  AUTHORIZATION_ACCESS_V1,
  type AuthorizationAccessV1,
  type Scope,
} from './access.contract.js';
import { canonicalUuid } from '../security/security-events.js';

const requirement = 'authorization.access@1.requirement';
export const RequireAccess = (permission: string, scopeType: Scope['type']) =>
  SetMetadata(requirement, { permission, scopeType });
interface ProtectedRequest extends IdentityRequest {
  params: { tenantId?: string; unitId?: string };
  url: string;
  body?: unknown;
  authorizedProjection?: { id: string; name: string };
}
@Injectable()
export class BusinessAuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly reads: AuthorizationReads,
    @Inject(AUTHORIZATION_ACCESS_V1)
    private readonly access: AuthorizationAccessV1,
    private readonly organizations: OrganizationsService,
  ) {}
  async canActivate(execution: ExecutionContext) {
    const req = execution.switchToHttp().getRequest<ProtectedRequest>();
    const policy = this.reflector.get<{
      permission: string;
      scopeType: Scope['type'];
    }>(requirement, execution.getHandler());
    if (
      !policy ||
      policy.scopeType !== 'COMPANY' ||
      !req.identity ||
      !canonicalUuid(req.params.tenantId) ||
      !canonicalUuid(req.params.unitId) ||
      req.url.includes('?') ||
      (req.body != null &&
        (typeof req.body !== 'object' || Object.keys(req.body).length > 0))
    )
      throw new NotFoundException('Resource unavailable');
    try {
      req.authorizedProjection = await this.reads.read(
        req.identity,
        req.params.tenantId,
        async (context) => {
          const decision = await this.access.can(context, policy.permission, {
            type: policy.scopeType,
            unitId: req.params.unitId!,
          });
          if (!decision.allowed) throw new ForbiddenException('Access denied');
          // Decision AND owner projection use this same manager/snapshot. Only
          // detached DTO leaves the callback, never context/manager/entities.
          const projection =
            await this.organizations.authorizedCompanyProjection(
              context.tenantId,
              req.params.unitId!,
              context.manager,
            );
          if (!projection) throw new ForbiddenException('Access denied');
          return projection;
        },
      );
      return true;
    } catch (error) {
      if (error instanceof NotFoundException)
        throw new NotFoundException('Resource unavailable');
      throw error;
    }
  }
}
@Controller('authorization/demo')
@UseGuards(AuthenticationGuard, BusinessAuthorizationGuard)
export class AuthorizationDemonstrationController {
  @Get('tenants/:tenantId/companies/:unitId')
  @Header('Cache-Control', 'no-store')
  @RequireAccess('foundation.probe.read', 'COMPANY')
  company(@Req() req: ProtectedRequest) {
    return req.authorizedProjection;
  }
}
