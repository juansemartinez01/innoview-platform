import { transientFailure } from '../operations/operation-context.js';
import { securityEvent, databaseFailure } from '../security/security-events.js';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Put,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import {
  AuthenticationGuard,
  AuthenticationModule,
  isVerifiedPrincipal,
  type IdentityRequest,
  type Principal,
} from '../authentication/authentication.module.js';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { UserIdentity } from './user-identity.entity.js';

@Injectable()
export class IdentityService {
  constructor(@Inject(DataSource) private readonly source: DataSource) {}

  async resolve(principal: Principal): Promise<UserIdentity> {
    try {
      const repository = this.source.getRepository(UserIdentity);
      // PostgreSQL's unique constraint serializes competing inserts. A separate
      // read gets a fresh READ COMMITTED snapshot after a conflicting insert.
      // DO NOTHING preserves UUID and timestamps on repeated authentication.
      await repository
        .createQueryBuilder()
        .insert()
        .values({
          issuer: principal.issuer,
          externalSubject: principal.subject,
        })
        .orIgnore()
        .execute();
      return await repository.findOneByOrFail({
        issuer: principal.issuer,
        externalSubject: principal.subject,
      });
    } catch (error) {
      if (!transientFailure(error)) throw error;
      securityEvent(databaseFailure(error));
      throw new ServiceUnavailableException('Identity persistence unavailable');
    }
  }

  // Read-only reference contract for the authenticated context coordinator.
  async findReference(
    principal: Principal,
    manager: EntityManager,
  ): Promise<string | null> {
    if (
      manager.connection !== this.source ||
      !manager.queryRunner?.isTransactionActive
    )
      throw new Error('Active local transaction required');
    const identity = await manager.getRepository(UserIdentity).findOne({
      select: { id: true },
      where: { issuer: principal.issuer, externalSubject: principal.subject },
    });
    return identity?.id ?? null;
  }

  async find(principal: Principal): Promise<UserIdentity> {
    let identity: UserIdentity | null;
    try {
      identity = await this.source.getRepository(UserIdentity).findOneBy({
        issuer: principal.issuer,
        externalSubject: principal.subject,
      });
    } catch (error) {
      if (!transientFailure(error)) throw error;
      securityEvent(databaseFailure(error));
      throw new ServiceUnavailableException('Identity persistence unavailable');
    }
    if (!identity) throw new NotFoundException('Local identity not registered');
    return identity;
  }
}

@Injectable()
export class IdentityReadTransactions {
  constructor(
    @Inject(DataSource) private readonly source: DataSource,
    private readonly identities: IdentityService,
  ) {}

  // Trusted backend contract: Principal comes from AuthenticationGuard, never
  // from request body, navigation cookies or a supplied internal UUID. No HTTP
  // may run in the callback. This is not a general business Unit of Work.
  async read<T>(
    principal: Principal,
    operation: (manager: EntityManager, identityId: string) => Promise<T>,
  ): Promise<T | null> {
    if (!isVerifiedPrincipal(principal)) return null;
    return this.source.transaction('REPEATABLE READ', async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      // A clean local scope also protects the initial lookup from any inherited
      // setting. Trusted application code never uses session-level SET here.
      await manager.query(
        "SELECT set_config('innoview.user_identity_id','',true), set_config('innoview.tenant_id','',true)",
      );
      const identityId = await this.identities.findReference(
        principal,
        manager,
      );
      if (!identityId) return null;
      await manager.query(
        "SELECT set_config('innoview.user_identity_id',$1,true)",
        [identityId],
      );
      return operation(manager, identityId);
    });
  }
}

@Controller('identity')
@UseGuards(AuthenticationGuard)
export class LocalIdentityController {
  constructor(private readonly identities: IdentityService) {}

  @Put('me')
  @Header('Cache-Control', 'no-store')
  resolve(
    @Req() request: IdentityRequest,
    @Body() body: unknown,
  ): Promise<UserIdentity> {
    if (
      body != null &&
      (typeof body !== 'object' || Object.keys(body).length !== 0)
    )
      throw new BadRequestException(
        'Identity fields are derived exclusively from the authenticated token',
      );
    return this.identities.resolve(request.identity!);
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  find(@Req() request: IdentityRequest): Promise<UserIdentity> {
    return this.identities.find(request.identity!);
  }
}

@Module({
  imports: [AuthenticationModule, PersistenceModule],
  controllers: [LocalIdentityController],
  providers: [IdentityService, IdentityReadTransactions],
  exports: [IdentityService, IdentityReadTransactions],
})
export class IdentityModule {}
