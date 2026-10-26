# Innoview Platform

Fase 0 cerrada e incrementos 1.1–1.5 aprobados, incluido el hardening de 27cb6c7. Incremento 1.6: contexto y selector mínimo Portal implementados, pendientes de revisión. Fase 1 todavía no declarada cerrada. Fuente de verdad: AGENTS.md y docs/. Sin administración pública de membresías, permisos empresariales ni RLS.

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
pnpm exec playwright install --only-shell chromium
```

Crear `.env` con catorce contraseñas/claves aleatorias e independientes, sin imprimirlas. Este comando **falla si el archivo ya existe**; para un entorno existente conservarlo y agregar únicamente las variables faltantes de `.env.example`.

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

Resultado esperado: tres servicios `healthy` y las seis migraciones FoundationProbe/BffSessions/UserIdentity/Organizations/Memberships/PortalContext marcadas `[X]`. Keycloak está en http://127.0.0.1:8080/admin/ con usuario `local_admin` y la contraseña de KEYCLOAK_ADMIN_PASSWORD en tu `.env`. El login de aplicaciones usa cuentas del realm innoview, no administradores master.

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

identity-bff tiene dos consumidores Next.js reales; sin paquetes vacíos, módulos comerciales ni worker. Organizations contiene Tenant/BusinessGroup/Company/Branch/OU con integridad transaccional, sin rutas públicas. Sin Membership, RBAC, RLS ni UoW genérico. Keycloak conserva cuentas y contraseñas empresariales; UserIdentity solo referencia issuer/sub con UUID propio. Integridad por tenant no equivale a autorización ni aislamiento de lectura.

## Contexto y selector mínimo Portal — 1.6

En una instalación existente, conservar `.env`, claves y volúmenes; ejecutar `pnpm db:run` y `pnpm db:show`. No se agregan secretos ni roles. PortalContext1793001600000 agrega únicamente selected_tenant_id y context_revision a portal_sessions.sessions; no cambia Control Center ni entidades empresariales.

Levantar `pnpm dev`, abrir http://127.0.0.1:3000 e iniciar sesión con una cuenta del realm innoview. El Portal muestra las organizaciones disponibles, un selector, la selección actual y un botón para limpiarla. Al recargar conserva la elección; cambiar de organización requiere validación nueva. Si no hay pertenencias activas/disponibles muestra «No tenés organizaciones disponibles». Volver a la página o recuperar foco comprueba nuevamente el contexto. Una revocación o desactivación detectada limpia la elección y pide elegir otra. Control Center conserva solo autenticación/identidad técnica.

No hay autoafiliación ni seeds de clientes. Para obtener opciones hacen falta Tenant/BusinessGroup/OU existentes ACTIVE e Identity existente con Membership ACTIVE creada por una operación confiable de 1.5. El login no crea tenants ni membresías. Sin esos datos la colección vacía es el resultado correcto; no hay un endpoint público o una pantalla para aprovisionarlos.

Contratos API, con Authorization Bearer de Portal y Cache-Control: no-store:

| Operación              | Entrada                                     | Respuesta                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /context/options   | Sin query/body ni user_identity_id          | 200 `{ "options": [{ "id": "tenant-uuid", "name": "Tenant", "group": { "id": "group-ou-uuid", "name": "Grupo" } }] }`; colección vacía si no hay identidad local/pertenencias disponibles |
| POST /context/validate | JSON exacto `{ "tenantId": "tenant-uuid" }` | 200 con una opción del mismo formato; 404 uniforme «Context unavailable» para ajeno/inexistente/revocado/inactivo/archivado; 400 para formato o campos inválidos                          |

JWT inválido/ausente: 401; cliente Control Center en estas rutas: 403, restricción técnica de superficie que no implica RBAC. AuthenticationModule valida el principal, IdentityModule consulta su UUID sin registrar nada y Memberships/Organizations aportan contratos de lectura en una transacción corta REPEATABLE READ y READ ONLY. El estado del grupo pertenece a su OU GROUP, conforme ADR-030; se exige también el registro BusinessGroup y Tenant ACTIVE. No se devuelven empresas, sucursales, membresías, roles ni identidades ajenas.

El navegador usa únicamente el BFF Portal:

- GET /auth/context → `{ options, selected, revision, invalidated }`, con selected nulo o una opción mínima. Revalida contra API y elimina preferencias obsoletas mediante CAS; no acepta candidatos/query.
- POST /auth/context/select → formulario exacto csrf, revision y tenantId. POST /auth/context/clear → csrf y revision. Ambos exigen sesión, Origin propio y CSRF; responden `{ selected, revision }`. Revisiones obsoletas/concurrentes: 409 para recargar y reintentar. No hay estas rutas en Control Center.

La cookie sigue conteniendo solo SID opaco sellado. El UUID elegido está exclusivamente en la fila técnica de sesión Portal, sin FK empresarial ni claim permanente. Su revisión optimista es independiente de la versión/lease de tokens: refresh no sobrescribe contexto y seleccionar no reescribe tokens. Logout elimina la fila completa. La invalidación automática de un UUID obsoleto en GET es mantenimiento derivado de PostgreSQL, sin candidatos aceptados ni posibilidad de limpiar una selección válida por parámetros. Ante errores de comprobación no se devuelve contexto como válido.

**La selección no concede permisos ni es autoridad para operaciones empresariales.** Cada operación futura deberá revalidar pertenencia, estados y permisos en su propia transacción. Una comprobación en curso ve su snapshot; una revocación confirmada se observa en comprobaciones nuevas, no cancela retroactivamente solicitudes ya iniciadas. No hay RLS ni contexto GUC definitivo: ADR-032/034 describen la integración futura, sin bypass.

Pruebas: `pnpm test` incluye PostgreSQL/Keycloak descartables, concurrencia, refresh, logout, aislamiento de procesos y Chromium real interactuando con el selector y ambas aplicaciones. **Playwright 1.64.1** es una dependencia exclusiva de pruebas compatible con Node 24; no agrega runtime ni un segundo framework de tests. Instalar su Chromium headless con el comando del inicio; en Linux/CI usar `pnpm exec playwright install --with-deps --only-shell chromium`. No se guardan trazas ni diagnósticos con credenciales. Los clientes/usuarios de prueba solo existen en Keycloak descartable.

## Aislamiento de credenciales por proceso — corrección de 1.5

Usar los comandos normales `pnpm dev`, `pnpm --filter @innoview/api dev` y, después de compilar, `pnpm --filter @innoview/api start`. Ambos scripts API pasan por `infra/api/runtime.mjs`. El launcher confiable interpreta `.env` sin cargarlo en el entorno de NestJS y crea un proceso nuevo con una lista explícita de variables. El CLI Nest y sus hijos de watch reciben ese entorno limpio. No se transmiten flags de carga de archivos, preloads, NODE_OPTIONS ni NODE_PATH.

La configuración admitida es **DB_HOST, DB_PORT, DB_NAME, DB_SSL, DB_APP_USER, DB_APP_PASSWORD, OIDC_ISSUER, AUTH_ENV, AUTH_ALLOW_HTTP, API_PORT y NODE_ENV**. Se conserva únicamente una lista de variables estándar del sistema necesarias para Windows/Linux (PATH, directorios de usuario/temporales y variables Windows de sistema/perfil); nunca se toman de `.env`. La política exacta está en `apps/api/src/runtime-environment.policy.json`. Variables del proceso padre prevalecen sobre `.env` para permitir configuración explícita del entorno; las no admitidas se descartan aunque se agreguen nuevas credenciales al archivo.

Quedan excluidos bootstrap, migrador, operador Memberships, Keycloak, PostgreSQL Identity, credenciales/claves de ambos BFF y testing. Antes de importar NestJS/AppModule, `main` comprueba que no haya familias de configuración privilegiada o secretos ajenos: una ejecución directa con el `.env` completo falla antes de conectar. Se informan solo nombres de variables admitidas/excluidas, jamás valores. La conexión valida además que el rol efectivo sea el de aplicación gestionado, sin privilegios administrativos.

No ejecutar el servidor con `node --env-file=.env ...` ni volver a añadir `.env` completo al comando Nest. Los comandos `db:provision`, `db:run/show/create/generate/revert` y `memberships:bootstrap` siguen siendo operaciones independientes confiables; sus credenciales no se heredan al servidor HTTP. Portal/Control Center conservan roles y claves propios; sus launchers excluyen los otros roles, claves y opciones Node. Las pruebas usan sus comandos normales con `--port` en puertos descartables; los valores predeterminados siguen en 3000/3001 y el contrato OIDC local no cambia.

Las pruebas automatizadas lanzan **pnpm API dev y start** con el entorno completo de una fixture PostgreSQL/Keycloak descartable, verifican los nombres presentes en el proceso real Nest y sus descendientes, conexión con DB_APP_USER y regresión OIDC/Identity/Memberships/bootstrap. No filtran las credenciales de la fixture desde el harness antes de ejecutar los launchers.

Límite: esto separa entornos de procesos; no es un sandbox del sistema operativo. El launcher, la terminal y las herramientas operativas son confiables y pueden leer secretos locales. Un proceso con el mismo usuario/permisos de archivos podría leer el `.env` compartido. En futuros despliegues usar secretos y permisos de archivo/usuario/contenedor separados por servicio, sin montar el `.env` global en API/BFF; no introducir preloads ni flags externos que carguen secretos antes del launcher. Desplegar también la política JSON compilada y los archivos del launcher usados por los scripts. No se implementa infraestructura de despliegue ni funcionalidades de 1.6.

## Memberships interno — 1.5

Conservar volúmenes y credenciales anteriores. Agregar `DB_MEMBERSHIP_USER=innoview_membership_operator` y `DB_MEMBERSHIP_PASSWORD` a `.env`: contraseña nueva e independiente, al menos 16 caracteres (recomendado 32 bytes aleatorios en hex). Repetir `pnpm db:provision`, `pnpm db:run` y `pnpm db:show`. No editar migraciones anteriores. `memberships` queda administrado por el migrador; API solo consulta `membership`, el operador escribe con grants limitados y BFF no accede al esquema. No inyectar credenciales operativas en despliegues API/BFF; los launchers BFF las filtran y la API no las requiere.

MembershipsService expone internamente register, listForIdentity, listActiveForIdentity, isActive, revoke y bootstrapFirst. Las escrituras exigen un DataSource operativo explícito; el provider de NestJS usa el rol API de lectura y las rechaza. No hay controllers, autoafiliación al login, selector ni permisos administrativos. ACTIVE significa pertenencia, sin autorizar datos; REVOKED es terminal. Cada solicitud futura deberá releer la pertenencia y comprobar también disponibilidad del tenant; no confiar en JWT/cookie/frontend.

El bootstrap lo realiza el operador autorizado del entorno, fuera de HTTP, sobre UUID existentes seleccionados explícitamente. Desde la raíz, reemplazar los tres UUID y el motivo:

```powershell
pnpm memberships:bootstrap --tenant-id <tenant-uuid> --user-identity-id <identity-uuid> --request-id <operation-uuid> --reason "Alta inicial autorizada; referencia al cambio aprobado"
```

El request UUID identifica una transición material y sus reintentos; conservarlo. El CLI deriva actor de host/cuenta OS y devuelve solo UUID/estado/changed/auditEventId. Solo crea la primera pertenencia del tenant; otro candidato o historial previo de origen distinto bloquea la operación. Repetir el bootstrap original devuelve su estado actual, incluso REVOKED, sin reactivar ni agregar privilegios. Repeticiones sin cambios devuelven el evento original, no consumen nuevos request UUID ni generan auditorías ficticias. Las siguientes altas/revocaciones requieren un consumidor interno confiable explícito con credenciales operativas; no se publica una API administrativa en 1.5.

Auditoría `memberships.audit_event`: CREATED/REVOKED, actor, rol PostgreSQL efectivo, motivo, fuente, request UUID y fecha; inserción por triggers en la misma transacción, sin modificaciones ni borrados runtime. Inspección solo por operador/migrador, no API/BFF. No incluir secretos en el motivo. Esto no es auditoría resistente a un migrador/operador del host privilegiado.

`pnpm test` ejecuta CLI real repetido y concurrente, altas muchos-a-muchos, revocaciones, FK/UNIQUE/clave compuesta, rechazo de escrituras no autorizadas y reconciliación de ACL contra PostgreSQL descartable; también login/logout/refresh reales con Keycloak y ausencia de autoafiliación/endpoints. No crea tenants o identidades reales ni ejecuta bootstrap sin UUID explícitos en tu base habitual. Diseño de consulta pretenant fail-closed para Fase 2: ADR-032 y ARCHITECTURE.md. **Todavía no hay RLS ni aislamiento de lecturas por usuario/tenant en SQL.**

## Organizations interno — 1.4

Sin variables o dependencias nuevas. En una instalación existente conservar `.env` y volúmenes:

```powershell
pnpm install --frozen-lockfile
docker compose up -d --wait --wait-timeout 240
pnpm db:provision
pnpm db:run
pnpm db:show
pnpm db:generate src/persistence/migrations/OrganizationsCheck --check
```

Organizations1792929600000 es aditiva; crea cinco tablas en organizations, constraints/FK, funciones de integridad y metadata STORED privada de TypeORM. db:provision agrega el esquema y permisos mínimos, incluyendo reconciliación de grants por columna; repetirlo conserva los datos. No borrar volúmenes ni ejecutar revert sobre desarrollo.

OrganizationsService ofrece solo createTenant (tenant + grupo + OU), createCompany, createBranch, getStructure y setStatus para consumidores internos. No hay controllers, endpoints, seeds ni comandos para dar de alta clientes reales. Autenticarse no crea tenants ni afiliaciones; conocer un UUID no habilita consultas HTTP organizacionales. El rol compartido aún puede leer estructuras de distintos tenants directamente: no presentar esta etapa como multi-tenant segura.

Nombre/estado/fechas comunes están en OU; los registros tipados comparten UUID y guardan únicamente parentesco/datos específicos. Los padres se derivan, sin parent_id duplicado. Estado ACTIVE↔INACTIVE y ambos→ARCHIVED terminal, con ancestros activos para crear/reactivar. Relaciones, constraints y límites: DATA_MODEL.md, ARCHITECTURE.md y ADR-030. Tenant sigue siendo límite lógico; no hay administración de Deployment.

Pruebas con `docker compose -f compose.test.yaml up -d --wait --wait-timeout 180` y `pnpm test`: estructuras sintéticas, cruces/tipos/ciclos/huérfanos, unicidad, rollback, concurrencia, estados, borrados, ACL y reversión/reaplicación descartable. También se verifica HTTP 404 en rutas Organizations aun con JWT válido y UUID de tenants existentes. No son pruebas de autorización/RLS.

Advertencia conocida: la introspección de columnas STORED en TypeORM 1.1.2 usa consultas simultáneas en un QueryRunner y pg 8.23.1 emite una advertencia de deprecación. Se verificó con trace: procede de PostgresQueryRunner.loadTables/schemaBuilder.log, no de transacciones del servicio. Tests y generate --check pasan; no se oculta ni se actualizan dependencias para silenciarla. Revalidar antes de adoptar pg 9.

## Autenticación e identidad local — 1.3

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
pnpm oidc:migrate:logout
pnpm oidc:provision
pnpm oidc:check
pnpm dev
```

El bloque anterior actualiza un entorno existente: db:provision agrega identity y ACL mínimas, db:run aplica UserIdentity1792922400000 y oidc:migrate:logout migra explícitamente los dos redirects al contrato v2. En un entorno limpio seguir el inicio desde clon nuevo: oidc:provision crea v2 directamente y no se ejecuta la migración de realm ausente. No hay variables ni dependencias nuevas en 1.3.

La migración OIDC requiere una ventana de mantenimiento sin ediciones simultáneas en Keycloak. Solo acepta v1/v1 parcial/v2 conocidos y compara campos gestionados; drift ajeno falla sin forzarlo. Es reanudable e idempotente, conserva IDs/usuarios/claves/clientes ajenos. Admin REST no ofrece transacción/CAS del conjunto: coordinar runtime e IdP, no mezclar versiones. No borrar volúmenes ni exportar secretos al repositorio. Detalle operativo en OIDC.md y ADR-029.

Para una cuenta real de desarrollo abrir la consola Keycloak en http://127.0.0.1:8080/admin/, seleccionar **innoview** y crear un usuario habilitado con perfil requerido completo y contraseña local. No asignar realm-management ni utilizar administradores master como usuarios de aplicaciones. No versionar usuarios/contraseñas. Los tests utilizan sus propias cuentas efímeras en otro servidor.

Abrir Portal http://127.0.0.1:3000 o Control Center http://127.0.0.1:3001, pulsar **Iniciar sesión**, autenticar en Keycloak y volver a la pantalla técnica con el UUID interno. El mismo usuario obtiene el mismo UUID en ambas apps, sin privilegios administrativos. Hay logout local y SSO; el segundo confirma en Keycloak y vuelve directamente a /auth/logout/callback, que valida state en servidor y redirige a raíz sin JavaScript. State ausente/incorrecto/duplicado/repetido devuelve 400. Recargar comprueba expiración/refresh; no hay polling que mantenga viva una sesión inactiva.

Rutas BFF en ambas apps: POST /auth/login, GET /auth/callback, GET /auth/session, POST /auth/logout y GET /auth/logout/callback. POST exige Origin/CSRF. GET API /auth/me conserva el principal OIDC. PUT /identity/me registra/resuelve la identidad propia y GET /identity/me la consulta (404 si no está registrada); ambos requieren Bearer válido, sin token responden 401. PUT solo admite body vacío y obtiene issuer/sub del Guard. La UI recibe UUID/identidad mínima y CSRF, nunca access/refresh tokens.

UserIdentity vive en identity.user_identity: UUID v4, issuer, external_subject, created_at/updated_at, pareja OIDC única en PostgreSQL. INSERT ON CONFLICT DO NOTHING y lectura posterior soportan concurrencia sin cambiar UUID/fechas. No hay email, contraseñas, tokens ni afiliaciones; updated_at no es last_login. AuthenticationModule verifica tokens; IdentityModule administra el registro. El BFF resuelve identidad al completar login y permite incorporar UUID a sesiones válidas de 1.2 sin descartarlas. Datos/modelo y límites en DATA_MODEL.md/ADR-028.

Issuer canónico: http://127.0.0.1:8080/realms/innoview. Clientes separados Code + PKCE S256, state/nonce, callbacks exactos en 3000/3001, audiencia innoview-api y scope openid. Cookies HttpOnly con SID sellado y claves independientes; payload servidor AES-256-GCM. Los roles innoview_portal/innoview_control solo acceden a portal_sessions/control_sessions respectivamente; API no puede leer sesiones. El .env conjunto es exclusivamente local: cada proceso desplegado debe recibir solo sus propias variables, sin bootstrap/migrador ni claves de la otra app. HTTPS/Secure obligatorios fuera de la excepción HTTP loopback explícita.

El aprovisionador crea únicamente un realm ausente. Si existe, verifica marca y campos del contrato; cualquier diferencia termina sin sobrescribir clientes. No tiene force/import override ni elimina datos. Usa credenciales administrativas locales solo para esta operación. Si falla, revisar el drift y acordar una actualización explícita; no borrar volúmenes. Realm master sigue separado y no se modifica.

Contrato, refresh serializado, identidad, migración logout y revocación: [docs/OIDC.md](docs/OIDC.md), ADR-025 a ADR-029. openid-client 6.8.8 e iron-session 9.0.1 tienen consumidores BFF; jose 6.2.13 valida JWT en NestJS. Logout local no revoca access tokens ya emitidos ni sesiones de otra aplicación. Backchannel y revocación global inmediata pendientes.

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

| Rol                  | Privilegios en la base Platform                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| platform_local_admin | Bootstrap administrativo; solo aprovisionamiento local                                                                                                                                                                                                                 |
| innoview_migrator    | CONNECT y propietario de foundation/platform_meta/portal_sessions/control_sessions/identity/organizations y sus objetos; sin privilegios globales ni membresías                                                                                                        |
| innoview_app         | CRUD en foundation y USAGE de secuencias; USAGE + SELECT/INSERT en identity, sin UPDATE/DELETE allí; Organizations SELECT/INSERT y UPDATE(status,updated_at) solo en Tenant/OU; sin DELETE, DDL, TEMP, TRUNCATE, SET ROLE migrador, historial ni acceso a sesiones BFF |
| innoview_portal      | CONNECT, USAGE/CRUD solo en portal_sessions; sin DDL, propiedad, membresías ni acceso a sesiones de Control Center                                                                                                                                                     |
| innoview_control     | CONNECT, USAGE/CRUD solo en control_sessions; sin DDL, propiedad, membresías ni acceso a sesiones de Portal                                                                                                                                                            |

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

Informe de Fase 0 aprobada: [docs/FOUNDATION.md](docs/FOUNDATION.md). Contrato y runtime: [docs/OIDC.md](docs/OIDC.md). Próximas fases: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). **No iniciar Fase 2 ni declarar cerrada Fase 1 sin revisión de 1.6.**
