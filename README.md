# Innoview Platform

Fase 0 cerrada e incremento 1.1 aprobado. Incremento 1.2: autenticación runtime y sesiones implementadas, pendiente revisión. Fuente de verdad: AGENTS.md y docs/. Sin organizaciones, autorización empresarial ni aislamiento multi-tenant.

## Requisitos

Node.js 24 LTS, fijado en **24.22.1** para desarrollo y CI, y pnpm **11.25.0**. `.node-version` configura GitHub Actions y gestores de versiones compatibles; `devEngines.runtime` permite a pnpm descargar y utilizar esa versión para los comandos del proyecto, sin cambiar la instalación global. `engines` y `engineStrict` restringen la compatibilidad a Node 24. `pnpm exec node --version` debe devolver `v24.22.1`. Node 22 ya no es el entorno de desarrollo admitido.

En una computadora nueva con Windows:

1. Instalar [Git](https://git-scm.com/downloads/win), [Node.js 24.22.1](https://nodejs.org/en/download) y [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/). Configurar el backend Linux (por ejemplo WSL 2), iniciar Docker Desktop y abrir PowerShell. No hace falta instalar PostgreSQL, Java ni Keycloak en el host.
2. Instalar pnpm con `npm install --global pnpm@11.25.0` si aún no está disponible. No actualizar dependencias ni regenerar el lockfile para comenzar.
3. Comprobar `git --version`, `node --version`, `pnpm --version`, `docker version` y `docker compose version`. Docker debe mostrar servidor Linux y Compose v2 con soporte para `up --wait` (verificado con 2.34.0).

## Inicio desde un clon nuevo

Ejecutar los bloques en orden. El último bloque de desarrollo queda abierto; usar otra terminal para consultas.

```powershell
git clone https://github.com/juansemartinez01/innoview-platform.git
Set-Location innoview-platform
pnpm install --frozen-lockfile
pnpm exec node --version
```

Crear `.env` con trece contraseñas/claves aleatorias e independientes, sin imprimirlas. Este comando **falla si el archivo ya existe**; para un entorno existente conservarlo y agregar únicamente las variables faltantes de `.env.example`.

```powershell
@'
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const text = readFileSync('.env.example', 'utf8').replace(
  /^([A-Z_]+PASSWORD)=\r?$/gm,
  (_, key) => key + '=' + randomBytes(32).toString('hex'),
);
writeFileSync('.env', text, { flag: 'wx' });
console.log('.env creado; credenciales locales omitidas.');
'@ | node --input-type=module
```

El ejemplo define host, puertos, base, usuarios y TLS local. No se necesitan otras variables ni copiar credenciales del equipo Innoview. Para iniciar la infraestructura y preparar la base:

```powershell
docker compose config --quiet
docker compose up -d --wait --wait-timeout 240
docker compose ps
pnpm db:provision
pnpm db:show
pnpm db:run
pnpm db:show
pnpm oidc:provision
pnpm oidc:check
```

Resultado esperado: tres servicios `healthy` y las dos migraciones FoundationProbe/BffSessions marcadas `[X]`. Keycloak está en http://127.0.0.1:8080/admin/ con usuario `local_admin` y la contraseña de KEYCLOAK_ADMIN_PASSWORD en tu `.env`. El login de aplicaciones usa cuentas del realm innoview, no administradores master.

Validar calidad y pruebas en PostgreSQL y Keycloak temporales independientes:

```powershell
docker compose -f compose.test.yaml up -d --wait --wait-timeout 180
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
docker compose -f compose.test.yaml down
pnpm dev
```

Resultado esperado: controles con código 0, pruebas sin fallos, tres builds y las tres aplicaciones disponibles en 3000/3001/3002. Después de arrancar, comprobar desde otra terminal:

```powershell
(Invoke-WebRequest 'http://127.0.0.1:3000').StatusCode
(Invoke-WebRequest 'http://127.0.0.1:3001').StatusCode
(Invoke-WebRequest 'http://127.0.0.1:3002').StatusCode
(Invoke-WebRequest 'http://127.0.0.1:8080/realms/innoview/.well-known/openid-configuration').StatusCode
```

Las cuatro respuestas deben ser 200. Detener `pnpm dev` con Ctrl+C antes de iniciar los servidores del build. Las secciones siguientes explican operación, migraciones y reinicios sin pérdida de datos.

Si hay conflictos de puertos, modificar PLATFORM_POSTGRES_PORT y DB_PORT juntos, KEYCLOAK_HTTP_PORT y TEST_DB_PORT en `.env`; usar los nuevos puertos en las consultas HTTP. Los puertos de aplicaciones son 3000/3001/3002 y deben estar libres. Para una segunda copia independiente usar `docker compose -p nombre-distinto ...` y `docker compose -p nombre-distinto-test -f compose.test.yaml ...` en **todos** sus comandos, con puertos distintos. Un clon nuevo no debe reutilizar accidentalmente los volúmenes de otra copia con contraseñas nuevas.

## Referencia de comandos desde la raíz

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
# Requiere primero PostgreSQL y Keycloak temporales descritos abajo.
pnpm test
pnpm build
pnpm dev
```

Desarrollo: portal http://127.0.0.1:3000, Control Center http://127.0.0.1:3001 y API http://127.0.0.1:3002. Detener con Ctrl+C.

Después del build, ejecutar cada aplicación por separado con `pnpm --filter @innoview/portal start`, `pnpm --filter @innoview/control-center start` y `pnpm --filter @innoview/api start`.

Las páginas permiten login/logout y muestran identidad técnica. GET /auth/me valida JWT; la raíz de API comprueba arranque. NestJS usa el rol restringido; preparar primero persistencia. Sin endpoints empresariales ni operaciones administrativas. Los servidores escuchan únicamente en loopback y no son una configuración de producción.

## Límites actuales

identity-bff tiene dos consumidores Next.js reales; sin paquetes vacíos, módulos comerciales ni worker. TypeORM y PostgreSQL contienen objetos técnicos de Foundation y sesiones. Sin Tenant/Company/Branch/UserIdentity/Membership, RLS ni UoW. OIDC y sesiones runtime implementados en 1.2; Keycloak conserva cuentas y contraseñas empresariales.

## Autenticación runtime — 1.2

Para actualizar una instalación existente, conservar `.env`. Agregar solo las variables faltantes de `.env.example`; este comando no cambia contraseñas ni claves anteriores:

```powershell
@'
import { readFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const old = readFileSync('.env', 'utf8');
const keys = new Set(old.split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => line.split('=')[0]));
const missing = readFileSync('.env.example', 'utf8').split(/\r?\n/)
  .filter(line => /^[A-Z_]+=/.test(line) && !keys.has(line.split('=')[0]))
  .map(line => line.endsWith('PASSWORD=') ? line + randomBytes(32).toString('hex') : line);
appendFileSync('.env', '\n' + missing.join('\n') + '\n');
console.log('Variables faltantes agregadas; secretos omitidos.');
'@ | node --input-type=module
```

Nuevas variables runtime: OIDC_ISSUER, AUTH_ENV=development, AUTH_ALLOW_HTTP=true, AUTH_API_ORIGIN, PORTAL_ORIGIN, CONTROL_ORIGIN, DB_PORTAL/CONTROL_USER/PASSWORD y cuatro claves PORTAL/CONTROL_COOKIE_PASSWORD/TOKEN_PASSWORD. Cada clave: 32 bytes aleatorios en 64 caracteres hex, diferentes entre aplicaciones y de las credenciales. No usar NEXT_PUBLIC para secretos. Si cambia KEYCLOAK_HTTP_PORT, ajustar también OIDC_ISSUER; los redirects registrados siguen en 3000/3001.

```powershell
pnpm install --frozen-lockfile
docker compose up -d --wait --wait-timeout 240
pnpm db:provision
pnpm db:run
pnpm db:show
pnpm oidc:provision
pnpm oidc:check
pnpm dev
```

Para una cuenta real de desarrollo abrir la consola Keycloak en http://127.0.0.1:8080/admin/, seleccionar **innoview** y crear un usuario habilitado con perfil requerido completo y contraseña local. No asignar realm-management ni utilizar administradores master como usuarios de aplicaciones. No versionar usuarios/contraseñas. Los tests utilizan sus propias cuentas efímeras en otro servidor.

Abrir Portal http://127.0.0.1:3000 o Control Center http://127.0.0.1:3001, pulsar **Iniciar sesión**, autenticar en Keycloak y volver a la pantalla técnica. Control Center no ofrece operaciones administrativas. Hay logout local y SSO; el segundo requiere confirmación en Keycloak y vuelve a raíz. Recargar comprueba expiración/refresh; no hay polling que mantenga viva una sesión inactiva.

Rutas BFF en ambas apps: POST /auth/login, GET /auth/callback, GET /auth/session, POST /auth/logout y GET /auth/logout/callback. POST exige Origin/CSRF. GET API /auth/me exige un access token Bearer válido; sin token responde 401. El navegador recibe identidad mínima y CSRF, nunca access/refresh tokens.

Issuer canónico: http://127.0.0.1:8080/realms/innoview. Clientes separados Code + PKCE S256, state/nonce, callbacks exactos en 3000/3001, audiencia innoview-api y scope openid. Cookies HttpOnly con SID sellado y claves independientes; payload servidor AES-256-GCM. Los roles innoview_portal/innoview_control solo acceden a portal_sessions/control_sessions respectivamente; API no puede leer sesiones. El .env conjunto es exclusivamente local: cada proceso desplegado debe recibir solo sus propias variables, sin bootstrap/migrador ni claves de la otra app. HTTPS/Secure obligatorios fuera de la excepción HTTP loopback explícita.

El aprovisionador crea únicamente un realm ausente. Si existe, verifica marca y campos del contrato; cualquier diferencia termina sin sobrescribir clientes. No tiene force/import override ni elimina datos. Usa credenciales administrativas locales solo para esta operación. Si falla, revisar el drift y acordar una actualización explícita; no borrar volúmenes. Realm master sigue separado y no se modifica.

Contrato, refresh serializado, custodia de tokens y revocación: [docs/OIDC.md](docs/OIDC.md), ADR-025/026/027. openid-client 6.8.8 e iron-session 9.0.1 tienen consumidores BFF; jose 6.2.13 valida JWT en NestJS. Logout local no revoca access tokens ya emitidos ni sesiones de otra aplicación. Backchannel y revocación global inmediata pendientes.

## Infraestructura local — solo desarrollo

Requiere Docker Desktop iniciado, contenedores Linux y Docker Compose v2. Se verificó en Windows/PowerShell con Docker Desktop 4.40.0 y Compose 2.34.0. Desde la raíz:

```powershell
# Crear solo si no existe: nunca sobrescribir credenciales locales.
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

El generador del inicio ya completa las contraseñas. Si se configura manualmente, completar en `.env` `PLATFORM_POSTGRES_PASSWORD`, `IDENTITY_POSTGRES_PASSWORD` y `KEYCLOAK_ADMIN_PASSWORD` con valores aleatorios independientes, además de las credenciales de persistencia y pruebas descritas abajo. No usar credenciales de producción. El ejemplo no contiene contraseñas funcionales y Compose exige valores no vacíos. `.env` está excluido de Git; no compartir su contenido ni la salida de `docker compose config` sin `--quiet`, que incluye los valores interpolados.

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
| innoview_migrator    | CONNECT y propietario de foundation/platform_meta/portal_sessions/control_sessions y sus objetos; sin privilegios globales ni membresías                                       |
| innoview_app         | CONNECT, USAGE en foundation, SELECT/INSERT/UPDATE/DELETE en sus tablas y USAGE en secuencias; sin propiedad, DDL, TEMP, TRUNCATE, SET ROLE migrador ni acceso a platform_meta |
| innoview_portal      | CONNECT, USAGE/CRUD solo en portal_sessions; sin DDL, propiedad, membresías ni acceso a sesiones de Control Center                                                             |
| innoview_control     | CONNECT, USAGE/CRUD solo en control_sessions; sin DDL, propiedad, membresías ni acceso a sesiones de Portal                                                                    |

El historial TypeORM está en `platform_meta.migrations`; la tabla de demostración, en `foundation.persistence_probe`. Los defaults de tablas/secuencias se aplican a objetos futuros creados por el migrador en foundation. No se otorgan permisos genéricos a futuros módulos: cada esquema necesitará una política explícita. Los controles se aplican a la base administrada, no alteran ACL de otras bases del clúster ni reemplazan políticas de conexión de producción.

Los DataSource de aplicación y migraciones son distintos y usan credenciales distintas. ESM/NodeNext con imports `.js`, `synchronize: false`, sin dropSchema ni migraciones automáticas. En desarrollo se carga `.env` raíz; en un despliegue futuro inyectar a la API DB_HOST/PORT/NAME/SSL, DB_APP_USER/PASSWORD y OIDC_ISSUER/política de transporte, sin credenciales de migrador/bootstrap. El lanzador Next carga el archivo mediante loadEnvFile (sin reenviar --env-file a NODE_OPTIONS) y retira credenciales administrativas, de pruebas y de la otra aplicación. `DB_SSL=require` verifica certificados; `disable` es explícito para este entorno local.

Comandos del CLI desde raíz (las rutas de salida se resuelven desde `apps/api`):

```powershell
pnpm db:create src/persistence/migrations/NextTechnicalChange
pnpm db:generate src/persistence/migrations/NextTechnicalChange
pnpm db:show
pnpm db:run
```

Cada comando compila antes de ejecutar el CLI. Editar/revisar el SQL generado antes de ejecutarlo. Como todavía no hay entidades, `generate` no produce cambios; su salida sin cambios tiene código 1 por convención de TypeORM, o 0 con `--check`. La reversión `pnpm db:revert` se bloquea en la base de desarrollo: requiere DB_DISPOSABLE=true y DB_NAME con el formato generado por las pruebas (`innoview_test_` seguido de 32 caracteres hexadecimales). La suite ejecuta reversión y reaplicación por CLI automáticamente en su base descartable. No cambiar esas variables para apuntar a datos existentes.

## Pruebas de integración PostgreSQL y OIDC

Completar TEST_POSTGRES_PASSWORD y TEST_KEYCLOAK_ADMIN_PASSWORD con valores aleatorios independientes. No reutilizar credenciales de desarrollo/producción. PostgreSQL usa tmpfs y puerto 55433; Keycloak usa dev-mem sin volúmenes, administrador test_admin y puerto 18081. El test exige puerto distinto del IdP normal y realm innoview inicialmente ausente. Ante un test interrumpido reiniciar solo keycloak-test descartable y esperar salud; nunca resetear el IdP de desarrollo.

```powershell
docker compose -f compose.test.yaml config --quiet
docker compose -f compose.test.yaml up -d --wait --wait-timeout 180
pnpm test
docker compose -f compose.test.yaml down
```

Node test runner ejecuta pruebas reales: conexiones, credenciales inválidas, migraciones, CRUD, secuencias, restricciones DDL/roles, defaults de objetos futuros, idempotencia y reversión/reaplicación. Cada ejecución crea una base y roles únicos y los elimina al terminar. Nunca toma DB_NAME como destino de borrado. No omite las pruebas si falta PostgreSQL: falla con una instrucción de configuración. **Estas pruebas no validan aislamiento multi-tenant ni RLS.**

También verifica aprovisionamiento OIDC real, discovery/JWKS, grants/redirects/PKCE, emisión para ambos clientes y preservación de configuraciones ajenas. La suite runtime arranca los tres servidores en 13000/13001/13002 y prueba sus rutas HTTP reales: login, callbacks/code, cookies, CSRF, expiración, revocación, refresh concurrente, logout y JWT. Usa base/roles únicos y artefactos .next-runtime-test; elimina solo sus fixtures. No es prueba visual de navegador ni validación de autorización empresarial/RLS. Usuarios sintéticos/efímeros y negativos criptográficos identificados por separado.

## Calidad y CI

`pnpm lint` utiliza ESLint flat config: reglas TypeScript con información de tipos para NestJS y Core Web Vitals/TypeScript para ambas aplicaciones Next.js. No se admiten advertencias. TypeScript conserva `strict` en la base y las diferencias necesarias de resolución NodeNext/bundler en cada aplicación.

`pnpm format` aplica Prettier y `pnpm format:check` verifica formato sin escribir. Se excluyen artefactos, lockfile y archivos que Next.js regenera. Las decisiones nuevas se registran explícitamente en las ADR.

`pnpm test` ejecuta los scripts `test` de los workspaces, incluyendo la integración real de API con PostgreSQL, y las pruebas OIDC de la raíz. No se agregaron tests ficticios ni se declara cobertura multi-tenant.

[GitHub Actions](https://github.com/juansemartinez01/innoview-platform/actions/workflows/ci.yml) ejecuta instalación congelada, lint, formato, tipos, tests y build en cada push y pull request. Crea PostgreSQL/Keycloak temporales con contraseñas aleatorias y los detiene al terminar. No depende de servicios locales ni secretos de producción, no despliega y tiene permisos de solo lectura. Las acciones están fijadas por SHA.

Informe de Fase 0 aprobada: [docs/FOUNDATION.md](docs/FOUNDATION.md). Contrato y runtime: [docs/OIDC.md](docs/OIDC.md). Próximos incrementos: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). **No avanzar más allá de 1.2 sin revisión.**
