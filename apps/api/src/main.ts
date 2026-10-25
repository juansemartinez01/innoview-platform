import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? 3002), '127.0.0.1');
}

bootstrap().catch(() => {
  console.error(
    'API startup failed. Verify database configuration and provisioning.',
  );
  process.exitCode = 1;
});
