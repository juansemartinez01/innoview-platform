# Innoview Platform

Foundation MVP, incrementos 0.1 a 0.5. Fuente de verdad: AGENTS.md y docs/.

## Requisitos

Node.js 24 LTS, fijado en **24.22.1** para desarrollo y CI, y pnpm **11.25.0**. `.node-version` configura GitHub Actions y gestores de versiones compatibles; `devEngines.runtime` permite a pnpm descargar y utilizar esa versión para los comandos del proyecto, sin cambiar la instalación global. `engines` y `engineStrict` restringen la compatibilidad a Node 24. `pnpm exec node --version` debe devolver `v24.22.1`. Node 22 ya no es el entorno de desarrollo admitido.

## Comandos desde la raíz

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
# Requiere primero el PostgreSQL temporal descrito abajo.
pnpm test
pnpm build
pnpm dev
```

Desarrollo: portal http://127.0.0.1:3000, Control Center http://127.0.0.1:3001 y API http://127.0.0.1:3002. Detener con Ctrl+C.

Después del build, ejecutar cada aplicación por separado con `pnpm --filter @innoview/portal start`, `pnpm --filter @innoview/control-center start` y `pnpm --filter @innoview/api start`.

Las páginas y la respuesta raíz de la API solo comprueban arranque. NestJS abre el DataSource con el rol restringido; preparar primero la persistencia descrita abajo. No hay endpoints de datos, autenticación ni administración todavía. Los servidores escuchan únicamente en loopback. No son una configuración de producción.

## Límites actuales

Sin paquetes compartidos vacíos, módulos comerciales ni worker. API conectada a PostgreSQL mediante TypeORM; solo existen objetos técnicos de demostración. Sin entidades Tenant/Company/Branch/UserIdentity/Membership, RLS ni UoW. OIDC y sesiones en las aplicaciones corresponden a Fase 1; Keycloak sigue separado.

## Infraestructura local — solo desarrollo

Requiere Docker Desktop iniciado, contenedores Linux y Docker Compose v2. Se verificó en Windows/PowerShell con Docker Desktop 4.40.0 y Compose 2.34.0. Desde la raíz:

```powershell
# Crear solo si no existe: nunca sobrescribir credenciales locales.
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Completar en `.env` tres contraseñas aleatorias e independientes: `PLATFORM_POSTGRES_PASSWORD`, `IDENTITY_POSTGRES_PASSWORD` y `KEYCLOAK_ADMIN_PASSWORD`. No usar credenciales de producción. El ejemplo no contiene contraseñas funcionales y Compose exige valores no vacíos. `.env` está excluido de Git; no compartir su contenido ni la salida de `docker compose config` sin `--quiet`, que incluye los valores interpolados.

```powershell
docker compose config --quiet
docker compose up -d --wait --wait-timeout 240
docker compose ps
```

| Servicio          | Imagen                           | Acceso                                                                |
| ----------------- | -------------------------------- | --------------------------------------------------------------------- |
| postgres-platform | postgres:18.6-bookworm           | 127.0.0.1:55432; base innoview_platform, usuario platform_local_admin |
| postgres-identity | postgres:18.6-bookworm           | Solo red Docker identity; base keycloak, usuario identity_local_owner |
| keycloak          | quay.io/keycloak/keycloak:26.8.1 | http://127.0.0.1:8080; administrador local_admin por defecto          |

Los puertos del host pueden cambiarse en `.env`; las publicaciones siempre usan 127.0.0.1. Keycloak ejecuta `start-dev`, sin TLS: **esta configuración no es apta para producción**. Su esquema interno se inicializa automáticamente por Keycloak; no son migraciones de Innoview. Los usuarios PostgreSQL indicados en la tabla son propietarios bootstrap de desarrollo, no credenciales para las aplicaciones. NestJS usa el rol restringido de 0.5.

Verificar disponibilidad después de `--wait`:

```powershell
docker compose exec -T postgres-platform pg_isready -h 127.0.0.1 -U platform_local_admin -d innoview_platform
docker compose exec -T postgres-identity pg_isready -h 127.0.0.1 -U identity_local_owner -d keycloak
(Invoke-WebRequest 'http://127.0.0.1:8080/realms/master/.well-known/openid-configuration').StatusCode
docker compose logs --tail 50 keycloak
```

La respuesta HTTP esperada es 200 (ajustar el puerto si se modificó). El healthcheck de Keycloak consulta `/health/ready` en el puerto interno 9000, incluyendo su conexión a la base. Identity y el puerto 9000 no se publican al host. Keycloak y Platform no comparten red Docker.

```powershell
# Reiniciar y esperar salud de los tres servicios.
docker compose restart
docker compose up -d --wait --wait-timeout 240

# Detener conservando contenedores y datos.
docker compose stop

# Retirar contenedores/redes conservando los volúmenes.
docker compose down

# Volver a levantar con los mismos datos.
docker compose up -d --wait --wait-timeout 240
```

No agregar `--volumes` a `down` ni eliminar volúmenes. El proyecto `innoview-platform-dev` conserva los volúmenes `platform-data` e `identity-data` de forma independiente. Cambiar contraseñas en `.env` no actualiza una base ya inicializada ni al administrador existente de Keycloak. No cambiar de versión principal PostgreSQL sobre un volumen existente: requiere un procedimiento de migración separado. Ver validaciones y decisiones en `docs/FOUNDATION.md`.

## Persistencia, roles y migraciones — 0.5

Para una base existente, conservar `.env` y agregar las variables nuevas de `.env.example` (no sobrescribirlo). Completar `DB_APP_PASSWORD` y `DB_MIGRATOR_PASSWORD` con valores aleatorios distintos entre sí y del bootstrap, mínimo 16 caracteres. Mantener los nombres `innoview_app` e `innoview_migrator`, y `DB_HOST/DB_PORT/DB_NAME/DB_SSL` según el entorno. Si se cambió PLATFORM_POSTGRES_PORT, ajustar también DB_PORT. Bootstrap reutiliza PLATFORM_POSTGRES_PASSWORD; nunca se usa para la conexión de la API.

```powershell
pnpm install --frozen-lockfile
docker compose up -d --wait --wait-timeout 240
pnpm db:provision
pnpm db:show
pnpm db:run
pnpm db:show
pnpm dev
```

`db:provision` es idempotente, transaccional y funciona sobre volúmenes ya inicializados. No borra bases ni datos. Crea roles administrados, esquemas y ACL; falla ante roles/esquemas ajenos o membresías inesperadas. Repetirlo reconcilia privilegios de los objetos administrados y actualiza las contraseñas de app/migrador a los valores locales. Ejecutarlo solo como mantenimiento local controlado. La API no aprovisiona, sincroniza ni ejecuta migraciones al arrancar.

| Rol                  | Privilegios en la base Platform                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| platform_local_admin | Bootstrap administrativo; solo aprovisionamiento local                                                                                                                         |
| innoview_migrator    | CONNECT y propietario de foundation/platform_meta y sus objetos; sin SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE, REPLICATION ni membresías                                     |
| innoview_app         | CONNECT, USAGE en foundation, SELECT/INSERT/UPDATE/DELETE en sus tablas y USAGE en secuencias; sin propiedad, DDL, TEMP, TRUNCATE, SET ROLE migrador ni acceso a platform_meta |

El historial TypeORM está en `platform_meta.migrations`; la tabla de demostración, en `foundation.persistence_probe`. Los defaults de tablas/secuencias se aplican a objetos futuros creados por el migrador en foundation. No se otorgan permisos genéricos a futuros módulos: cada esquema necesitará una política explícita. Los controles se aplican a la base administrada, no alteran ACL de otras bases del clúster ni reemplazan políticas de conexión de producción.

Los DataSource de aplicación y migraciones son distintos y usan credenciales distintas. ESM/NodeNext con imports `.js`, `synchronize: false`, sin dropSchema ni migraciones automáticas. En desarrollo Node carga el `.env` de la raíz; en un despliegue futuro inyectar a la API únicamente DB_HOST/PORT/NAME/SSL y DB_APP_USER/PASSWORD, sin credenciales de migrador/bootstrap. `DB_SSL=require` verifica certificados; `disable` es explícito para este entorno local.

Comandos del CLI desde raíz (las rutas de salida se resuelven desde `apps/api`):

```powershell
pnpm db:create src/persistence/migrations/NextTechnicalChange
pnpm db:generate src/persistence/migrations/NextTechnicalChange
pnpm db:show
pnpm db:run
```

Cada comando compila antes de ejecutar el CLI. Editar/revisar el SQL generado antes de ejecutarlo. Como todavía no hay entidades, `generate` no produce cambios; su salida sin cambios tiene código 1 por convención de TypeORM, o 0 con `--check`. La reversión `pnpm db:revert` se bloquea en la base de desarrollo: requiere DB_DISPOSABLE=true y DB_NAME con el formato generado por las pruebas (`innoview_test_` seguido de 32 caracteres hexadecimales). La suite ejecuta reversión y reaplicación por CLI automáticamente en su base descartable. No cambiar esas variables para apuntar a datos existentes.

## Pruebas de integración PostgreSQL

Completar `TEST_POSTGRES_PASSWORD` en `.env` con otro valor aleatorio. No reutilizar credenciales de desarrollo/producción. El servidor de pruebas no conecta volúmenes y almacena datos en tmpfs; tiene proyecto y puerto separados (55433 por defecto).

```powershell
docker compose -f compose.test.yaml config --quiet
docker compose -f compose.test.yaml up -d --wait --wait-timeout 120
pnpm test
docker compose -f compose.test.yaml down
```

Node test runner ejecuta pruebas reales: conexiones, credenciales inválidas, migraciones, CRUD, secuencias, restricciones DDL/roles, defaults de objetos futuros, idempotencia y reversión/reaplicación. Cada ejecución crea una base y roles únicos y los elimina al terminar. Nunca toma DB_NAME como destino de borrado. No omite las pruebas si falta PostgreSQL: falla con una instrucción de configuración. **Estas pruebas no validan aislamiento multi-tenant ni RLS.**

## Calidad y CI

`pnpm lint` utiliza ESLint flat config: reglas TypeScript con información de tipos para NestJS y Core Web Vitals/TypeScript para ambas aplicaciones Next.js. No se admiten advertencias. TypeScript conserva `strict` en la base y las diferencias necesarias de resolución NodeNext/bundler en cada aplicación.

`pnpm format` aplica Prettier y `pnpm format:check` verifica formato sin escribir. Se excluyen artefactos, lockfile y archivos que Next.js regenera. Los cambios en documentos existentes son de formato, sin alterar las ADR.

`pnpm test` ejecuta los scripts `test` de los workspaces, incluyendo la integración real de API con PostgreSQL. No se agregaron tests ficticios ni se declara cobertura multi-tenant.

[GitHub Actions](https://github.com/juansemartinez01/innoview-platform/actions/workflows/ci.yml) ejecuta instalación congelada, lint, formato, tipos, tests y build en cada push y pull request. Crea PostgreSQL temporal con contraseña aleatoria en cada run y lo detiene siempre. No depende de PostgreSQL local ni de secretos de producción, no despliega y tiene permisos de solo lectura. Las acciones están fijadas por SHA.

Versiones, fuentes, privilegios y riesgos: docs/FOUNDATION.md. Próximo incremento: **0.6, verificación integral y documentación final de Fase 0**, después de revisar 0.5.
