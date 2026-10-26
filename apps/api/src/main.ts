import {
  assertApiRuntimeEnvironment,
  ApiRuntimeEnvironmentError,
} from './runtime-environment.js';

async function bootstrap(): Promise<void> {
  assertApiRuntimeEnvironment();
  console.info(
    `API runtime admitted variables: ${JSON.stringify(Object.keys(process.env).sort())}`,
  );
  await import('reflect-metadata');
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule);
  const { correlate, HttpSecurityErrors } =
    await import('./security/http-security.js');
  app.use(correlate);
  app.useGlobalFilters(new HttpSecurityErrors());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT ?? 3002), '127.0.0.1');
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ApiRuntimeEnvironmentError) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  console.error(
    'API startup failed. Verify database configuration and provisioning.',
  );
  process.exitCode = 1;
});
