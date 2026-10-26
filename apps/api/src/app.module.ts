import { ContextModule } from './context/context.module.js';
import { MembershipsModule } from './memberships/memberships.module.js';
import { OrganizationsModule } from './organizations/organizations.module.js';
import { Module } from '@nestjs/common';
import { IdentityModule } from './identity/identity.module.js';
import { AppController } from './app.controller.js';
import { PersistenceModule } from './persistence/persistence.module.js';

@Module({
  imports: [
    PersistenceModule,
    IdentityModule,
    OrganizationsModule,
    MembershipsModule,
    ContextModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
