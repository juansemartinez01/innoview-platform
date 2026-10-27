import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { AuthorizationService } from './authorization.service.js';
import { AuthenticationModule } from '../authentication/authentication.module.js';
import { ContextModule } from '../context/context.module.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { OrganizationsModule } from '../organizations/organizations.module.js';
import {
  AuthorizationReads,
  AuthorizationEvaluator,
} from './access.runtime.js';
import { AUTHORIZATION_ACCESS_V1 } from './access.contract.js';
import {
  CompanyDemonstrationGuard,
  AuthorizationDemonstrationController,
} from './demonstration.js';
@Module({
  imports: [
    PersistenceModule,
    AuthenticationModule,
    ContextModule,
    MembershipsModule,
    OrganizationsModule,
  ],
  providers: [
    AuthorizationService,
    AuthorizationReads,
    AuthorizationEvaluator,
    { provide: AUTHORIZATION_ACCESS_V1, useExisting: AuthorizationEvaluator },
    CompanyDemonstrationGuard,
  ],
  exports: [AuthorizationService, AuthorizationReads, AUTHORIZATION_ACCESS_V1],
  controllers: [AuthorizationDemonstrationController],
})
export class AuthorizationModule {}
