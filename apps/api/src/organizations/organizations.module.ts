import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { OrganizationsService } from './organizations.service.js';

// Deliberately no controllers/routes until membership authorization and RLS.
@Module({
  imports: [PersistenceModule],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
