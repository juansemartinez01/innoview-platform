import { securityEvent, databaseFailure } from '../security/security-events.js';
import type { EntityManager } from 'typeorm';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  AuthenticationGuard,
  AuthenticationModule,
  type IdentityRequest,
  type Principal,
} from '../authentication/authentication.module.js';
import {
  IdentityModule,
  IdentityReadTransactions,
} from '../identity/identity.module.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { OrganizationsService } from '../organizations/organizations.service.js';

export type ContextOption = {
  id: string;
  name: string;
  group: { id: string; name: string };
};

@Injectable()
export class TenantReadTransactions {
  constructor(
    private readonly identities: IdentityReadTransactions,
    private readonly memberships: MembershipsService,
    private readonly organizations: OrganizationsService,
  ) {}
  // Trusted backend only: AuthenticationGuard supplies Principal. This scope
  // validates membership, not future company/branch permissions. No HTTP here.
  async read<T>(
    principal: Principal,
    candidate: string,
    operation: (
      manager: EntityManager,
      option: ContextOption,
    ) => Promise<T> | T,
  ): Promise<T> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        candidate,
      )
    )
      throw new NotFoundException('Context unavailable');
    const result = await this.identities.read(
      principal,
      async (manager, identityId) => {
        const refs = await this.memberships.activeTenantReferences(
          identityId,
          manager,
        );
        const [option] = await this.organizations.availableContextSummaries(
          refs.filter((id) => id === candidate),
          manager,
        );
        if (!option) throw new NotFoundException('Context unavailable');
        await manager.query("SELECT set_config('innoview.tenant_id',$1,true)", [
          option.id,
        ]);
        return { value: await operation(manager, option) };
      },
    );
    if (!result) throw new NotFoundException('Context unavailable');
    return result.value;
  }
}

@Injectable()
export class ContextService {
  constructor(
    private readonly identityTransactions: IdentityReadTransactions,
    private readonly memberships: MembershipsService,
    private readonly organizations: OrganizationsService,
    private readonly tenants: TenantReadTransactions,
  ) {}

  async options(principal: Principal, candidate?: string) {
    try {
      // Concrete composition of module contracts, not private cross-module SQL
      // or a generic UoW. One snapshot, no HTTP and no business-data queries.
      return (
        (await this.identityTransactions.read(
          principal,
          async (manager, identityId) => {
            const tenantIds = await this.memberships.activeTenantReferences(
              identityId,
              manager,
            );
            return this.organizations.availableContextSummaries(
              candidate
                ? tenantIds.filter((id) => id === candidate)
                : tenantIds,
              manager,
            );
          },
        )) ?? []
      );
    } catch (error) {
      securityEvent(databaseFailure(error));
      throw new ServiceUnavailableException('Context verification unavailable');
    }
  }
  async validate(principal: Principal, tenantId: string) {
    try {
      return await this.tenants.read(
        principal,
        tenantId,
        (_manager, option) => option,
      );
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      securityEvent(databaseFailure(error));
      throw new ServiceUnavailableException('Context verification unavailable');
    }
  }
}

@Controller('context')
@UseGuards(AuthenticationGuard)
export class ContextController {
  constructor(private readonly contexts: ContextService) {}
  private principal(request: IdentityRequest & { url: string }) {
    if (request.identity!.clientId !== 'innoview-portal')
      throw new ForbiddenException('Context is available only in Portal');
    if (request.url.includes('?'))
      throw new BadRequestException('Context parameters are not accepted');
    return request.identity!;
  }
  @Get('options')
  @Header('Cache-Control', 'no-store')
  options(
    @Req() request: IdentityRequest & { url: string },
    @Body() body: unknown,
  ) {
    const principal = this.principal(request);
    if (body != null && (typeof body !== 'object' || Object.keys(body).length))
      throw new BadRequestException('Context parameters are not accepted');
    return this.contexts.options(principal).then((options) => ({ options }));
  }
  @Post('validate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  validate(
    @Req() request: IdentityRequest & { url: string },
    @Body() body: unknown,
  ) {
    const principal = this.principal(request);
    if (
      typeof body !== 'object' ||
      body === null ||
      Object.keys(body).length !== 1 ||
      !('tenantId' in body) ||
      typeof body.tenantId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        body.tenantId,
      )
    )
      throw new BadRequestException('A tenant UUID is required');
    return this.contexts.validate(principal, body.tenantId.toLowerCase());
  }
}

@Module({
  imports: [
    AuthenticationModule,
    IdentityModule,
    MembershipsModule,
    OrganizationsModule,
  ],
  providers: [ContextService, TenantReadTransactions],
  exports: [TenantReadTransactions],
  controllers: [ContextController],
})
export class ContextModule {}
