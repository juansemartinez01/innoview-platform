import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { initializeApplicationDataSource } from './data-sources.js';

@Injectable()
class DatabaseShutdown implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly source: DataSource) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.source.isInitialized) await this.source.destroy();
  }
}

@Module({
  providers: [
    {
      provide: DataSource,
      useFactory: () => initializeApplicationDataSource(),
    },
    DatabaseShutdown,
  ],
  exports: [DataSource],
})
export class PersistenceModule {}
