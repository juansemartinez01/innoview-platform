import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { PersistenceModule } from './persistence/persistence.module.js';

@Module({ imports: [PersistenceModule], controllers: [AppController] })
export class AppModule {}
