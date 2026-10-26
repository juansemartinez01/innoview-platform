import { Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { MembershipsService } from './memberships.service.js';

// Read-only at API runtime. No public membership-management controllers.
@Module({
  imports: [PersistenceModule],
  providers: [MembershipsService],
  exports: [MembershipsService],
})
export class MembershipsModule {}
