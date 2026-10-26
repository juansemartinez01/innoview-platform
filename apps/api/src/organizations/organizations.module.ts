import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { OrganizationsService } from './organizations.service.js';

// Private structures remain internal. ContextModule exposes only validated summaries.
@Module({
  imports: [PersistenceModule],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
