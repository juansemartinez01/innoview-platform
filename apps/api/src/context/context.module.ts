import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Injectable,
  Inject,
  Module,
  NotFoundException,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  AuthenticationGuard,
  AuthenticationModule,
  type IdentityRequest,
  type Principal,
} from '../authentication/authentication.module.js';
import {
  IdentityModule,
  IdentityService,
} from '../identity/identity.module.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import { OrganizationsService } from '../organizations/organizations.service.js';
import { PersistenceModule } from '../persistence/persistence.module.js';

@Injectable()
export class ContextService {
  constructor(
    @Inject(DataSource) private readonly source: DataSource,
    private readonly identities: IdentityService,
    private readonly memberships: MembershipsService,
    private readonly organizations: OrganizationsService,
  ) {}

  async options(principal: Principal, candidate?: string) {
    try {
      // Concrete composition of module contracts, not private cross-module SQL
      // or a generic UoW. One snapshot, no HTTP and no business-data queries.
      return await this.source.transaction(
        'REPEATABLE READ',
        async (manager) => {
          await manager.query('SET TRANSACTION READ ONLY');
          const identityId = await this.identities.findReference(
            principal,
            manager,
          );
          if (!identityId) return [];
          const tenantIds = await this.memberships.activeTenantReferences(
            identityId,
            manager,
          );
          return this.organizations.availableContextSummaries(
            candidate ? tenantIds.filter((id) => id === candidate) : tenantIds,
            manager,
          );
        },
      );
    } catch {
      throw new ServiceUnavailableException('Context verification unavailable');
    }
  }
  async validate(principal: Principal, tenantId: string) {
    const [option] = await this.options(principal, tenantId);
    // Same response for foreign, missing, revoked, inactive and archived.
    if (!option) throw new NotFoundException('Context unavailable');
    return option;
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
    PersistenceModule,
    IdentityModule,
    MembershipsModule,
    OrganizationsModule,
  ],
  providers: [ContextService],
  controllers: [ContextController],
})
export class ContextModule {}
