# Innoview Platform

Fases 0 y 1 cerradas; **2.4 aprobado en `07f6b59258306bf67074b402cd71145707c83283`**. El incremento **2.5** endurece procedencia, operadores y recuperación. Fase 2 permanece pendiente de revisión del Director técnico y Auditor. No se inicia administración delegada ni Fases 3/4.

## Hardening y recuperación — 2.5

ADR-042 y [runbook operativo](docs/OPERATIONS_RUNBOOK.md) tienen precedencia sobre los apartados históricos. Se mantienen dependencias/versiones, login, sesiones y endpoints. No se crean permisos ni administradores para usuarios reales.

- IdentityReadTransactions exige el Principal original verificado por Authentication; los objetos literales y clones no abren la lectura.
- Organizations separa aprovisionamiento pretenant, operador por tenant y mantenimiento del directorio. Dos credenciales nuevas independientes en `.env.example`, excluidas de API y ambos BFF. Migraciones **13 y 14** aditivas; no editar historia ni borrar volúmenes.
- Replay Authorization usa la versión persistida y el algoritmo histórico v2 congelado. No cambia CURRENT_FINGERPRINT_VERSION.
- CompanyDemonstrationGuard solo protege su ruta técnica existente y conserva decisión/proyección en una transacción. Un fallo interno responde 500 sin Retry-After; indisponibilidad real responde 503. Correlación y eventos sin SQL/secretos.
- Reparación explícita de tenant_directory con backup custom PostgreSQL verificable, gate transaccional, comparación, auditoría e idempotencia propias. Nunca startup ni HTTP.

Comandos de verificación adicionales (Node/pnpm/Docker Desktop y Chromium como se explica debajo):

```powershell
pnpm security:matrix after
pnpm foundation:verify-clean
pnpm authorization:rls:benchmark
pnpm authorization:benchmark
pnpm authorization:benchmark:wide
```

`foundation:verify-clean` copia solo archivos versionables a un árbol temporal sin `.env`, instala frozen y levanta tres servicios con tmpfs y un proyecto Compose único. Ejecuta build y suites reales, incluyendo pg_dump/pg_restore, API restaurada y navegador; limpia solo sus recursos. Puede generar secretos efímeros o recibir TEST_POSTGRES_PASSWORD, TEST_KEYCLOAK_ADMIN_PASSWORD y TEST_IDENTITY_POSTGRES_PASSWORD inyectados. CI lo ejecuta como job independiente. Los benchmarks pesados siguen fuera de CI ordinaria.

Operación local, con servidores/escritores detenidos y los nuevos secretos configurados sin imprimirlos:

```powershell
pnpm db:backup --directory C:\Backups\Innoview
pnpm db:provision
pnpm db:run
pnpm db:provision
pnpm db:show
pnpm db:diagnose
pnpm directory:maintain
```

El backup devuelve la ruta del manifiesto, nunca credenciales. Su directorio debe tener ACL privadas. Para alta pretenant y reparación confirmada, usar los ejemplos y responsabilidades del runbook: son operaciones técnicas confiables, no administración empresarial. La restauración automática únicamente admite bases generadas descartables.

## Evaluación efectiva — 2.4

La migración aditiva 12 `IndexableIdentityTenantRls1793124000000` cambia solo los predicados app de Memberships/directorio/Organizations a igualdades UUID con CASE seguro. Mantiene roles, ACL, ENABLE/FORCE y fronteras restrictivas. No editar las once migraciones anteriores. Detener servidores y escritores para actualizar; conservar `.env`, sesiones y volúmenes:

```powershell
pnpm install --frozen-lockfile
pnpm db:run
pnpm db:show
pnpm db:diagnose
pnpm db:generate src/persistence/migrations/SchemaCheck --check
pnpm dev
```

`authorization.access@1` tiene implementación funcional con el rol app. `AuthorizationReads` recibe únicamente un Principal emitido por el verificador OIDC, resuelve Identity existente, Membership ACTIVE y disponibilidad del tenant, y crea un contexto válido solo durante su transacción REPEATABLE READ/READ ONLY. No hay registro de identidad/membresía ni privilegios implícitos. `can` usa EXISTS puntual por scope; `permissionsFor` y `scopesFor` usan conjuntos agrupados/materializados, sin N+1. Scopes exactos, sin herencia; rol/permiso/concesiones/unidad y ancestros deben estar ACTIVE. No se cachean decisiones entre requests.

Ruta técnica: `GET /authorization/demo/tenants/:tenantId/companies/:unitId`, con `Authorization: Bearer <access-token>` válido. Tenant/unit son candidatos, no autoridad. Requiere `foundation.probe.read` sobre esa COMPANY exacta; AuthenticationGuard verifica JWT y CompanyDemonstrationGuard ejecuta decisión y lectura de proyección con el mismo manager/snapshot. Solo devuelve `{id,name}`, con Cache-Control:no-store. No devuelve datos RBAC, tax_id ni otras compañías. No recibe identityId/membershipId/roles por body/query. No se agregan pantallas ni administración RBAC; Control Center permanece técnico.

401 para JWT ausente/inválido; 403 sin concesión o scope autorizado; 404 uniforme para contexto no disponible/ajeno/malformado; 503/Retry-After ante indisponibilidad. Errores tienen correlationId validado/generado también en header y eventos seguros. Permission DEPRECATED niega acceso y registra como máximo un evento agregado por request, sin código/filas sensibles. La selección BFF nunca concede acceso.

La demostración ALLOW/DENY está automatizada con usuarios/roles/tenants descartables y Keycloak real en `pnpm test`. No se crean administradores ni permisos para usuarios habituales de desarrollo. Para reproducir mediciones separadas de CI ordinaria:

```powershell
docker compose -f compose.test.yaml up -d --wait --wait-timeout 180
pnpm authorization:rls:benchmark
pnpm authorization:benchmark
docker compose -f compose.test.yaml down
```

El primer comando compara schema 11→12 sobre 20.000 membresías; el segundo ejecuta el evaluador definitivo sobre 500 tenants / 50.000 asignaciones, conserva el oráculo SQL anterior y registra planes/p50/p95. Artefactos en infra/authorization; metodología y límites en [runbook](docs/OPERATIONS_RUNBOOK.md). Las condiciones iniciales son después de carga/VACUUM, no una caché OS fría; no hay SLA productivo. Pendientes 2.5: D-5/huellas históricas, A-2, reparación de directorio, instalación desde cero y pruebas adversariales integrales.

## Preparación del evaluador — 2.3b.1

`assign()` primero comprueba replay en una transacción corta de solo lectura. Si no encuentra una operación completada equivalente, consulta a Memberships/Organizations sin retener conexión, transacción o locks de Authorization. La escritura idempotente definitiva vuelve a resolver concurrencia mediante UNIQUE antes de aceptar o rechazar las referencias. Un replay conserva el resultado original aunque cambien pertenencia, tenant, unidad o rol; no crea una nueva concesión ni demuestra acceso actual. Una operación nueva sigue validando referencias vigentes. Errores de adquisición de pools se convierten en fallos transitorios seguros; registro/datos/auditoría no quedan parcialmente confirmados.

Sin nuevos privilegios, dependencias o migraciones. `pnpm authorization:benchmark` conserva 500 tenants/50.000 asignaciones descartables y añade prototipos SQL de permisos, scopes y concesión exacta, con variantes inline/materializadas. Ejecuta VACUUM (ANALYZE) fuera de transacciones y guarda todos los planes JSON, filas/loops, buffers, filtros, condiciones de índice y heap fetches. Se conserva `assignment_member_scope` porque los planes representativos lo utilizan; no se crean índices especulativos. No hay servicios funcionales can/permissionsFor/scopesFor. Procedimiento y resultados en [runbook](docs/OPERATIONS_RUNBOOK.md); decisiones y riesgos en ADR-040.

## Modelo RBAC — 2.3b

Authorization es dueño de ocho tablas: Permission y CatalogVersion globales; Role, RolePermission, RoleAssignment, TenantAuthorizationRevision, Operation y AuditEvent por tenant. La undécima migración `AuthorizationModel1793037600000` agrega restricciones, auditoría, revisiones bigint y RLS ENABLE/FORCE. Se conservan las diez migraciones anteriores. Las entidades TypeORM tienen `synchronize: false`; sus constraints y triggers se administran mediante SQL versionado.

El catálogo técnico mínimo `foundation.probe.read/write` no concede ninguna capacidad HTTP. Solo el migrador puede cambiar Permission, mediante migraciones; código inmutable, deprecación terminal e historial preservado. Cada cambio real incrementa la versión global. Roles homónimos entre tenants son válidos; asignaciones usan FK compuestas y scopes exactos GROUP/COMPANY/BRANCH, sin herencia. Cada cambio real de concesiones incrementa atómicamente la revisión del tenant. No hay caché ni proveedor funcional para `authorization.access@1`.

Para actualizar, detener servidores y escritores operativos. Conservar `.env` y volúmenes. Agregar `DB_AUTHORIZATION_USER=innoview_authorization_operator` y `DB_AUTHORIZATION_PASSWORD` aleatoria nueva e independiente (32 bytes hex recomendados, mínimo 16 caracteres). No copiar valores de otros roles ni imprimirlos. Después:

```powershell
pnpm install --frozen-lockfile
docker compose up -d --wait --wait-timeout 240
pnpm db:provision
pnpm db:run
pnpm db:provision
pnpm db:show
pnpm db:diagnose
pnpm dev
```

El operador Authorization es independiente, sin DDL/ownership/BYPASSRLS ni acceso a sesiones o tablas privadas de otros módulos. Su transacción valida el rol, recibe tenant/actor/motivo/requestId/tipo confiables, establece GUC LOCAL y usa el mismo manager. Los launchers API/Portal/Control Center excluyen ambas variables Authorization, incluso heredadas del padre. El HTTP sigue usando solo DB_APP. El servicio técnico no tiene controlador: se instancia en herramientas confiables con su DataSource propio y contratos de los propietarios Memberships/Organizations con conexiones independientes. No introducir esas credenciales en los servidores HTTP.

Pruebas y benchmark se ejecutan exclusivamente sobre bases generadas descartables:

```powershell
docker compose -f compose.test.yaml up -d --wait --wait-timeout 180
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm authorization:benchmark
docker compose -f compose.test.yaml down
```

El benchmark pesado no forma parte de CI ordinaria: semilla fija, 500 tenants, 50.000 asignaciones, distribución sesgada y triggers activos. Escribe `infra/authorization/benchmark-result.json` con planes JSON resumidos y mediciones locales; no representa el evaluador de 2.4. La suite normal conserva EXPLAIN de 20.000 operaciones Organizations en lotes acotados, sin umbrales arbitrarios de tiempo.

Organizations y Authorization usan `lock_timeout=8s` LOCAL en el camino confiable (default del rol 1s, statement 20s). Los fallos transitorios producen error técnico tipado y evento de contención seguro; reintentar manualmente el mismo requestId tras resolver la causa. REQUEST_ID_CONFLICT es permanente. No se agregan endpoints ni reintentos ilimitados.

Una asignación persistida no es una decisión de acceso. En 2.4 se revalidarán transaccionalmente pertenencia, tenant, unidad y ancestros ACTIVE, además del permiso/rol/concesiones. Las comprobaciones técnicas actuales entre propietarios tienen una ventana TOCTOU documentada; una revisión RBAC no invalida por sí sola los cambios de Memberships/Organizations. Ver [ADR-039](docs/DECISIONS.md), [modelo](docs/DATA_MODEL.md) y [runbook](docs/OPERATIONS_RUNBOOK.md).

## Corrección 2.3a.1

La décima migración OperationTriggerHardening1793030400000 mantiene el historial y reemplaza funciones sin modificar migraciones previas. Los triggers validan el GUC antes de convertirlo a UUID y consultan por PK indexable; inválido/ausente se rechaza con 42501 sin 22P02. Completar una operación exige el mismo request contextual. Auditoría nueva sin DEFAULT de legado y con technical_source obligatorio para procedencia verificada; filas históricas preservadas.

Operaciones existentes conservan fingerprint_version=1 y su replay original; nuevas usan v2 recursiva, tipada y determinista, sin librerías nuevas. Se prueban Tenant y Company v1 creados en esquema anterior a la migración y reintentados después. Detener **todos los escritores** y aplicaciones para actualizar código/migración de forma coordinada; conservar `.env` y volúmenes. Ejecutar la secuencia de actualización del runbook: `pnpm install --frozen-lockfile`, `pnpm db:provision`, `pnpm db:run`, `pnpm db:provision`, `pnpm db:show`, `pnpm db:diagnose`, reiniciar con `pnpm dev`.

lock_timeout en conexiones nuevas: API/BFF/operadores 1 s, migrador 3 s, bootstrap sin modificación. Otros límites sin cambios. Ante 55P03, resolver contención durante mantenimiento, comprobar rollback/historial y repetir la misma migración; no reintentar ciegamente DDL encolado. [Runbook](docs/OPERATIONS_RUNBOOK.md) detalla riesgos, versiones y recuperación.

Resultado local: **120 resultados satisfactorios (75 PostgreSQL + 45 entorno/OIDC/runtime/Chromium)**, cero fallos. La prueba normal carga 20.000 operaciones únicamente en una base generada descartable y compara EXPLAIN JSON: antes Seq Scan, después Index Scan operation_pkey para ambas búsquedas; no usa tiempos de reloj como criterio ni fuerza planes. Pruebas adicionales de GUC inválido, UPDATE ajeno, constraints de auditoría y recuperación de locks/pools/DDL. No ejecutar esa carga sobre la base habitual. Alcance del operador, reasonCode futuro, consulta conjunta de registro/eventos, dependencia SQL de políticas, GUC alterables y advertencia TypeORM/pg permanecen abiertos (ADR-038).

## Operaciones confiables y hardening — 2.3a

No hay variables, credenciales ni dependencias nuevas. Detener aplicaciones para actualizar código/migración coordinadamente, conservar `.env`/volúmenes/sesiones y reiniciar pools tras aprovisionar:

```powershell
pnpm install --frozen-lockfile
docker compose up -d --wait --wait-timeout 240
pnpm db:provision
pnpm db:run
pnpm db:provision
pnpm db:show
pnpm db:diagnose
pnpm dev
```

La novena migración OrganizationOperations1793023200000 crea el registro durable de operaciones con PK global request_id. Organizations requiere contexto explícito actor/reason/requestId y actorType técnico; el invocador conserva el UUID por operación lógica y lo reutiliza en reintentos. Mismos argumentos/contexto devuelven el resultado original; reutilización incompatible produce REQUEST_ID_CONFLICT. Registro, estructura, auditoría y directorio son atómicos. No hay unicidad ingenua sobre eventos ni limpieza automática del registro. Auditoría anterior mantiene sus datos y queda identificada como LEGACY_UNVERIFIED; USER_IDENTITY tiene FK preparada pero su uso está rechazado hasta existir administración autorizada. getStructure exige manager transaccional de la misma fuente, sin transacción interna opcional.

Timeouts efectivos en conexiones nuevas: API/BFF **5s statement / 10s idle-in-transaction / 30s transaction**; operadores **20s / 30s / 120s**. Migrador/bootstrap conservan sus límites administrativos. No hacen revocación instantánea ni resisten SQL arbitrario. Detalle, pruebas y ajuste en [runbook](docs/OPERATIONS_RUNBOOK.md).

`db:diagnose` ejecuta con rol Organizations validado y transacciones read-only: inventario de tablas/columnas/ACL/RLS/políticas/roles/defaults y comparación completa del directorio con su fuente. Sale 1 ante hallazgos o indisponibilidad; no modifica ni repara. No necesita bootstrap/migrador ni expone información por HTTP. Su proceso solo requiere DB_HOST/PORT/NAME/SSL y DB_ORGANIZATIONS_USER/PASSWORD; las herramientas locales pueden leer `.env`, mientras los launchers API/BFF siguen filtrando esas credenciales. Las excepciones no-RLS y la dependencia Memberships/directorio son explícitas y se prueban con drift inducido únicamente en fixtures.

La API devuelve X-Correlation-Id UUID controlado y registra eventos de seguridad mínimos correlacionados; no registra JWT, cookies, secretos, SQL/argumentos o identidades completas. 42501, ausencia inesperada de contexto y conexión indisponible son categorías distintas. Un resultado vacío bajo RLS no se marca automáticamente como ataque. Las respuestas conservan mensajes seguros y no se agregan rutas.

Validar con `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`; PostgreSQL/Keycloak descartables mediante compose.test.yaml y Chromium como en las instrucciones existentes. Resultado local: **111 resultados satisfactorios (66 PostgreSQL + 45 entorno/OIDC/runtime/Chromium)**. Diagnóstico local: 16 tablas inventariadas, sin hallazgos ni divergencias; nueve migraciones aplicadas y generate --check sin diferencias. Runbook completo, contrato de firmas, normalización/replay, retención y recuperación manual de emergencia: [OPERATIONS_RUNBOOK.md](docs/OPERATIONS_RUNBOOK.md); decisiones: ADR-037. Reparación soportada e instalación desde cero con comando documentado y comprobación CI son criterios programados para **2.5**, no capacidades completadas en 2.3a.

RLS actual impone aislamiento tenant sobre las tablas privadas implementadas. Permisos entre empresas/sucursales del mismo tenant quedan para 2.4 y pruebas de 2.5; archivos/jobs futuros requieren controles propios. Siguen abiertos GUC alterables por SQL arbitrario, snapshots en curso, falta de Guards/caché de autorización, reparación soportada de directorio pendiente y advertencia conocida TypeORM/pg. No hay cambios en login, logout, refresh o selección de navegación.

## Contexto tenant y RLS Organizations — 2.2

Para actualizar una base existente, conservar `.env`, sesiones y volúmenes. Detener las aplicaciones antes del cambio coordinado de código y políticas. Agregar únicamente `DB_ORGANIZATIONS_USER=innoview_organizations_operator` y `DB_ORGANIZATIONS_PASSWORD` con una contraseña aleatoria nueva e independiente (32 bytes hex recomendados; mínimo 16 caracteres). No imprimirla ni reutilizar contraseñas de otros roles.

```powershell
pnpm install --frozen-lockfile
docker compose up -d --wait --wait-timeout 240
pnpm db:provision
pnpm db:run
pnpm db:provision
pnpm db:show
pnpm dev
```

El primer aprovisionamiento incorpora el operador; la octava migración OrganizationsTenantRls1793016000000 conserva datos, crea un directorio derivado mínimo y auditoría técnica, retira escrituras API y activa ENABLE/FORCE RLS. El segundo reconcilia grants exactos sobre objetos nuevos. No requiere revertir ni deshabilitar RLS, recrear bases o iniciar sesión nuevamente. No mezclar procesos antiguos con políticas nuevas: fallarán cerrados. Un clon limpio utiliza el inicio habitual y aplica las ocho migraciones.

Pretenant: `GET /context/options` mantiene `{ options: [{ id, name, group: { id, name } }] }`. Solo membresías ACTIVE propias, Tenant ACTIVE y OU GROUP ACTIVE. IdentityReadTransactions deriva UUID del Principal JWT validado, limpia ambos contextos LOCAL y establece identidad en una transacción read-only. Organizations consulta únicamente `tenant_directory`; API tiene SELECT por columna de tenant_id/tenant_name/group_id/group_name/available, con RLS por pertenencia propia. Una columna nueva no recibe acceso automático. Sin tenant contextual no se leen las tablas privadas, tampoco mediante joins con el directorio.

Tenant validado: `POST /context/validate`, body exacto `{ "tenantId": "UUID" }`, devuelve esa opción mínima o 404 uniforme. TenantReadTransactions verifica pertenencia y disponibilidad en el mismo snapshot, fija `innoview.tenant_id` LOCAL y entrega el mismo EntityManager al consumidor backend. No recibe user_identity_id ni hace HTTP dentro de SQL. Las cinco tablas privadas exigen tenant contextual coincidente y directorio disponible propio; límites RESTRICTIVE impiden ampliación por otra política permisiva. Contexto ausente/malformado/ajeno falla cerrado sin casts de GUC a UUID. Ambos contextos desaparecen con commit/rollback. La preferencia del Portal y Control Center no cambian; no hay endpoints de compañías/sucursales.

| Actor                       | Organizations: permisos efectivos                                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                         | SELECT privado sujeto a identidad, pertenencia ACTIVE y tenant LOCAL; directorio mínimo por columnas y pertenencia. Sin INSERT/UPDATE/DELETE, auditoría, DDL, ownership, SUPERUSER o BYPASSRLS                                                           |
| Operador Organizations      | SELECT/INSERT de los siete objetos exactos; UPDATE(status,updated_at) en Tenant/OU y actualización derivada del directorio. Políticas propias, contexto técnico obligatorio, sin DELETE/DDL/ownership/roles elevados ni tablas privadas de otros módulos |
| Operador Memberships        | Sin acceso Organizations; FK existentes, bootstrap, revocación terminal y auditoría conservados con sus políticas propias                                                                                                                                |
| BFF Portal / Control Center | Solo sus sesiones, sin credenciales operativas ni acceso Organizations                                                                                                                                                                                   |
| Migrador                    | Dueño DDL, sujeto a FORCE para DML sin política; actor confiable capaz de modificar políticas. Nunca runtime                                                                                                                                             |
| Bootstrap                   | Solo aprovisionamiento controlado; nunca API, selector ni consultas normales                                                                                                                                                                             |

Operación interna confiable: el operador técnico Innoview ejecuta un proceso separado que obtiene `initializeOrganizationsOperatorDataSource` y utiliza `OrganizationsService` (createTenant/createCompany/createBranch/setStatus/getStructure). No son funciones HTTP ni administración delegada. Entregar al proceso operativo solo DB_HOST/PORT/NAME/SSL y DB_ORGANIZATIONS_USER/PASSWORD; no requiere bootstrap/migrador. El provider Nest sigue usando DB_APP y rechaza escrituras. Las pruebas ejercitan ese mismo contrato con credenciales descartables.

Cada escritura interna fija actor técnico host:usuario y UUID de request LOCAL. Los triggers invocantes registran INSERT/STATUS_CHANGED con actor DB, referencia y estados en audit_event; cambios y eventos se confirman juntos. No se registran contraseñas ni perfiles, ni se inventa historial anterior a la migración. No se permite insertar auditoría ni editar directorio directamente. Triggers diferidos sincronizan su disponibilidad en el mismo commit, respetando integridad/FK/estados previos. Un estado repetido no duplica eventos. Atribución OS/credencial técnica no equivale a identidad empresarial o firma criptográfica.

Los launchers excluyen también DB_ORGANIZATIONS_* de API y BFF; dev/start, guard de arranque y descendientes se verifican con las variables completas de la fixture. No inyectar esos secretos al runtime desplegado. Las herramientas operativas pueden leer `.env` local pero sus secretos nunca pasan al servidor HTTP.

Validación: `docker compose -f compose.test.yaml up -d --wait --wait-timeout 180`, `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`; luego `docker compose -f compose.test.yaml down` sin `--volumes`. Resultado local 2.2: **99 resultados aprobados (55 PostgreSQL + 44 entorno/OIDC/runtime/Chromium), cero fallos**. Las pruebas agregan SQL sin filtros/joins, tres tenants y dos identidades más una vacía, límites de columnas, pool físico único, concurrencia, estados/revocación, auditoría/ACL y upgrade de datos existentes. Continúan Keycloak, Chromium y bootstrap. Solo se revierten bases generadas por las pruebas. `pnpm db:generate src/persistence/migrations/SchemaCheck --check` verifica que metadata y esquema coincidan, sin generar archivos.

**Límites:** contexto y RLS no conceden permisos sobre compañías/sucursales. No hay RBAC ni Guards empresariales. Una transacción iniciada conserva su snapshot ante revocaciones; comprobaciones nuevas ven cambios confirmados. Un atacante con SQL arbitrario puede modificar GUC: no son credenciales y no sustituyen autenticación/consultas parametrizadas/autorización. No se cubren todavía jobs, archivos o cachés. [ADR-036](docs/DECISIONS.md) detalla políticas, actores y coordinación. 2.2 aprobado; 2.3a se revisa por separado (ADR-037).

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

Crear `.env` con dieciséis contraseñas/claves aleatorias e independientes, sin imprimirlas. Este comando **falla si el archivo ya existe**; para un entorno existente conservarlo y agregar únicamente las variables faltantes de `.env.example`.

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

Resultado esperado: tres servicios `healthy` y las siete migraciones FoundationProbe/BffSessions/UserIdentity/Organizations/Memberships/PortalContext/MembershipIdentityRls marcadas `[X]`. Keycloak está en http://127.0.0.1:8080/admin/ con usuario `local_admin` y la contraseña de KEYCLOAK_ADMIN_PASSWORD en tu `.env`. El login de aplicaciones usa cuentas del realm innoview, no administradores master.

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

identity-bff tiene dos consumidores Next.js reales; sin paquetes vacíos, módulos comerciales ni worker. Organizations contiene Tenant/BusinessGroup/Company/Branch/OU con integridad transaccional, sin rutas públicas. Memberships y RLS vigentes se describen en ADR-035/036; sin RBAC ni UoW genérico. Keycloak conserva cuentas y contraseñas empresariales; UserIdentity solo referencia issuer/sub con UUID propio. Integridad por tenant no equivale a autorización ni aislamiento de lectura.

## Primer RLS de Memberships — 2.1

No hay variables, dependencias ni contraseñas nuevas. Para una instalación existente, detener los servidores de desarrollo antes de actualizar código/migración; conservar `.env`, volúmenes y sesiones. Ejecutar `pnpm install --frozen-lockfile`, `pnpm db:run`, `pnpm db:show` y reiniciar con `pnpm dev`. MembershipIdentityRls1793008800000 activa ENABLE/FORCE RLS sin cambiar filas, FK, grants ni migraciones previas. Los comandos de bootstrap/provisionamiento siguen separados y con sus propias credenciales. No deshabilitar RLS para resolver errores de la aplicación.

AuthenticationModule valida el JWT antes de ejecutar servicios. IdentityReadTransactions.read recibe ese Principal confiable y abre una transacción app REPEATABLE READ/READ ONLY. Inicializa LOCAL vacío, busca el UUID existente mediante IdentityModule y fija innoview.user_identity_id con set_config(..., true); no acepta UUID desde el navegador ni registra identidades. La operación usa el mismo EntityManager; sin identidad válida/local no se ejecuta. ContextModule consulta pertenencias y disponibilidad organizacional dentro de ese scope, conservando el contrato del selector.

La política compara el UUID de fila como texto con el contexto: ausente, vacío, inválido/no canónico o de otra identidad → ninguna fila visible, sin cast inseguro. Funciona también para SQL directo sin WHERE, no depende de filtros TypeORM. Un usuario puede ver su historia REVOKED; el servicio sigue filtrando ACTIVE para seleccionar. No es una política de permisos empresariales ni de aislamiento Organizations.

| Actor PostgreSQL        | Privilegios y políticas efectivos                                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aplicación API          | SELECT de membership únicamente para identidad contextual; política restrictiva adicional impide que otra SELECT permisiva amplíe el límite. Sin INSERT/UPDATE/DELETE/DDL, ownership, SUPERUSER, BYPASSRLS ni SET ROLE operativo                                           |
| Operador Memberships    | Políticas propias SELECT completo, INSERT y UPDATE; ACL siguen limitando UPDATE a status/updated_at. Triggers invocantes exigen contexto operativo y generan auditoría atómica. Sin DELETE/DDL/SUPERUSER/BYPASSRLS; no lee tablas privadas Identity/Organizations/sesiones |
| Migrador                | Propietario DDL, sin SUPERUSER/BYPASSRLS. FORCE lo sujeta a RLS para DML y no tiene política de lectura de membership; no usarlo como observador de datos ni credencial HTTP. Sí puede cambiar DDL/políticas, por lo que sigue siendo un actor confiable                   |
| Bootstrap               | Administrador existente, solo aprovisionamiento local controlado; nunca lookup inicial de identidad, consultas de aislamiento ni runtime                                                                                                                                   |
| Portal / Control Center | Conservan acceso a sus sesiones, sin acceso al esquema Memberships ni credenciales operativas                                                                                                                                                                              |

Una consulta app fuera del scope transaccional devuelve colección vacía/false aunque reciba un user_identity_id correcto. Pasar siempre el manager del scope a los contratos de lectura; no compartirlo entre solicitudes. LOCAL se retira automáticamente al confirmar/revertir, antes de devolver la conexión al pool. No usar SET SESSION: su valor se restauraría tras finalizar un LOCAL. La garantía se verifica con el mismo pg_backend_pid en un pool de una conexión, cambios de identidad, rollback y concurrencia.

**Límite de confianza:** el GUC no autentica. Un atacante con SQL arbitrario en esa misma conexión puede cambiarlo y suplantar una identidad. RLS no sustituye validación JWT, autorización NestJS futura, consultas parametrizadas ni separación de secretos. El helper es un contrato backend confiable, no un verificador JWT alternativo. No hay SECURITY DEFINER ni BYPASSRLS para resolver el UUID inicial. En 2.1 Organizations no tenía RLS; 2.2 lo incorpora conforme ADR-036. La selección Portal sigue siendo solo preferencia.

FK/UNIQUE/PK verifican integridad global incluso sobre filas ocultas; los SELECT explícitos de triggers obedecen al actor. Las políticas del operador permiten contar todo el historial para bootstrap/idempotencia. Auditoría permanece privada por ACL y triggers. Una prueba fuerza rechazo RLS en la segunda escritura de una transacción y verifica que tampoco persistan la primera ni sus eventos. No exponer diagnósticos SQL por HTTP: las restricciones pueden revelar existencia a escritores confiables. Operación y decisión completas: ADR-035.

`pnpm test` mantiene CLI bootstrap real, PostgreSQL/Keycloak descartables, JWT concurrentes, navegador real, login/logout/refresh y aislamiento de secretos. Agrega SQL directo sin filtros/joins, contextos inválidos, mismo pool tras commit/rollback, identidad sin pertenencias, límites restrictivos y FK bajo FORCE. Son pruebas de **aislamiento RLS de Memberships por identidad**, no de autorización empresarial, RBAC o RLS de tenants/empresas/sucursales. 2.1 aprobado; extensión de Organizations en 2.2/ADR-036.

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

**La selección no concede permisos ni es autoridad para operaciones empresariales.** Cada operación futura deberá revalidar pertenencia, estados y permisos en su propia transacción. Una comprobación en curso ve su snapshot; una revocación confirmada se observa en comprobaciones nuevas, no cancela retroactivamente solicitudes ya iniciadas. 2.1 agrega identidad LOCAL/RLS Memberships; 2.2 agrega tenant LOCAL/RLS Organizations (ADR-035/036).

Pruebas: `pnpm test` incluye PostgreSQL/Keycloak descartables, concurrencia, refresh, logout, aislamiento de procesos y Chromium real interactuando con el selector y ambas aplicaciones. **Playwright 1.64.1** es una dependencia exclusiva de pruebas compatible con Node 24; no agrega runtime ni un segundo framework de tests. Instalar su Chromium headless con el comando del inicio; en una máquina Linux nueva usar `pnpm exec playwright install --with-deps --only-shell chromium`. CI fija Ubuntu 24.04 (bibliotecas de navegador preinstaladas), descarga solo Chromium y verifica su arranque antes de las pruebas; instalación limitada a cinco minutos, sin actualizar fuentes/paquetes OS ajenos. No se guardan trazas ni diagnósticos con credenciales. Los clientes/usuarios de prueba solo existen en Keycloak descartable.

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

`pnpm test` ejecuta CLI real repetido y concurrente, altas muchos-a-muchos, revocaciones, FK/UNIQUE/clave compuesta, rechazo de escrituras no autorizadas y reconciliación de ACL contra PostgreSQL descartable; también login/logout/refresh reales con Keycloak y ausencia de autoafiliación/endpoints. No crea tenants o identidades reales ni ejecuta bootstrap sin UUID explícitos en tu base habitual. Diseño de consulta pretenant fail-closed para Fase 2: ADR-032 y ARCHITECTURE.md. Estado histórico de 1.5: RLS por identidad/tenant se agrega en 2.1/2.2.

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

Node test runner ejecuta pruebas reales: conexiones, credenciales inválidas, migraciones, CRUD, secuencias, restricciones DDL/roles, defaults de objetos futuros, idempotencia y reversión/reaplicación. Cada ejecución crea una base y roles únicos y los elimina al terminar. Nunca toma DB_NAME como destino de borrado. No omite las pruebas si falta PostgreSQL: falla con una instrucción de configuración. Las pruebas iniciales de 0.5 validan persistencia; las suites 2.1/2.2 agregan aislamiento RLS por identidad/tenant.

También verifica aprovisionamiento OIDC real, discovery/JWKS, grants/redirects/PKCE, emisión para ambos clientes y preservación de configuraciones ajenas. La suite runtime arranca los tres servidores en 13000/13001/13002 y prueba sus rutas HTTP reales: login, callbacks/code, cookies, CSRF, expiración, revocación, refresh concurrente, logout y JWT. Usa base/roles únicos y artefactos .next-runtime-test; elimina solo sus fixtures. Además se conserva Chromium real para el selector; 2.1/2.2 agregan pruebas RLS SQL. No se valida autorización empresarial. Usuarios sintéticos/efímeros y negativos criptográficos identificados por separado.

## Calidad y CI

`pnpm lint` utiliza ESLint flat config: reglas TypeScript con información de tipos para NestJS y Core Web Vitals/TypeScript para ambas aplicaciones Next.js. No se admiten advertencias. TypeScript conserva `strict` en la base y las diferencias necesarias de resolución NodeNext/bundler en cada aplicación.

`pnpm format` aplica Prettier y `pnpm format:check` verifica formato sin escribir. Se excluyen artefactos, lockfile y archivos que Next.js regenera. Las decisiones nuevas se registran explícitamente en las ADR.

`pnpm test` ejecuta los scripts `test` de los workspaces, incluyendo la integración real de API con PostgreSQL, y las pruebas OIDC de la raíz. No se agregaron tests ficticios ni se declara cobertura multi-tenant.

[GitHub Actions](https://github.com/juansemartinez01/innoview-platform/actions/workflows/ci.yml) ejecuta instalación congelada, lint, formato, tipos, tests y build en cada push y pull request. Crea PostgreSQL/Keycloak temporales con contraseñas aleatorias y los detiene al terminar. No depende de servicios locales ni secretos de producción, no despliega y tiene permisos de solo lectura. Las acciones están fijadas por SHA.

Informe de Fase 0 aprobada: [docs/FOUNDATION.md](docs/FOUNDATION.md). Contrato y runtime: [docs/OIDC.md](docs/OIDC.md). Fases 0/1 cerradas por el usuario; estado y siguientes incrementos: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md). **2.1/2.2 aprobados; 2.3a aprobado con condiciones y 2.3a.1 pendiente de revisión. No avanzar a 2.3b ni RBAC.**
