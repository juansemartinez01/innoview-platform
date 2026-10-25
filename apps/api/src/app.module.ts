import { Module } from '@nestjs/common';
import { IdentityModule } from './identity/identity.module.js';
import { AppController } from './app.controller.js';
import { PersistenceModule } from './persistence/persistence.module.js';

@Module({
  imports: [PersistenceModule, IdentityModule],
  controllers: [AppController],
})
export class AppModule {}
