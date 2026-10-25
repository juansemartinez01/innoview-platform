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
import { DataSource } from 'typeorm';
import {
  AuthenticationGuard,
  AuthenticationModule,
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
    } catch {
      throw new ServiceUnavailableException('Identity persistence unavailable');
    }
  }

  async find(principal: Principal): Promise<UserIdentity> {
    let identity: UserIdentity | null;
    try {
      identity = await this.source.getRepository(UserIdentity).findOneBy({
        issuer: principal.issuer,
        externalSubject: principal.subject,
      });
    } catch {
      throw new ServiceUnavailableException('Identity persistence unavailable');
    }
    if (!identity) throw new NotFoundException('Local identity not registered');
    return identity;
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
  providers: [IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}
