# Arquitectura técnica — v0.3

## Evaluación empresarial — contrato vigente 2.4 / ADR-041

2.3b.1 aprobado en 9ab0810. E-1 se ejecutó primero: migración 12 actualiza14políticas app a comparación UUID indexable, preservando ENABLE/FORCE, RESTRICTIVE y privilegios. Prueba representativa schema 11→12 mantiene visibilidad/denegaciones y utiliza ix_membership_identity_status sin hints. Las políticas operativas no cambian.

AuthenticationGuard verifica JWT y el verificador marca el Principal emitido mediante WeakSet privado (no serializable/fabricable por DTO). AuthorizationReads acepta solo esos objetos, compone Identity existente/Membership/Organizations con el mismo EntityManager app REPEATABLE READ/READ ONLY y GUC LOCAL, y emite un contexto con procedencia privada y vigencia acotada al callback. Se comprueban source, transacción, aislamiento, read-only, GUC y rol app en runtime. Manager y contexto nunca se guardan en singletons ni entre requests; el manager no es enumerable/serializable. El contexto se invalida también ante rollback. No hay alta implícita de Identity o Membership.

authorization.access@1 conserva firmas/tipos públicos. Evaluador app-only, sin conexión operativa ni cache entre requests. can usa EXISTS exacto con filtros tenant/membership/type/unit; no materializa toda la pertenencia. Listados agrupan conjuntos MATERIALIZED y deduplican permisos/scopes en una consulta de datos, con una comprobación constante del contexto adicional. Memberships y Organizations son dueños de dos relaciones SQL internas concretas: pertenencia activa y unidades disponibles/ancestros. Authorization compone esos contratos nativos en su consulta; no escribe SQL a tablas privadas ajenas desde un módulo comercial ni crea UoW/builder genérico. Contratos solo backend nativo, no API externa; el adaptador externo futuro permanece pendiente.

Ruta de demostración Company: AuthenticationGuard → BusinessAuthorizationGuard → AuthorizationReads. Dentro del callback, can decide y Organizations devuelve únicamente id/name usando el mismo manager; solo ese DTO sale de la transacción. El controller no vuelve a leer entidades. Patrón obligatorio para futuras operaciones: autorización y efecto/lectura deben compartir transacción o reevaluarse en la transacción que opere. No transportar un ALLOW, contexto o manager a otro request.

Estados y semántica: default deny, grant-only, scopes exactos sin herencia. Se verifican pertenencia/tenant/grupo, RoleAssignment/Role/RolePermission/Permission y unidad/ancestros ACTIVE; el rol INACTIVE conserva historia pero no concede acceso. Permiso DEPRECATED conocido devuelve NO_GRANT; UNKNOWN_PERMISSION interno no se expone por HTTP. Telemetría de deprecación agregada por request, sin códigos/identidades/tokens. HTTP 401 / 403 / 404 uniforme / 503+Retry-After y correlationId en respuesta/evento, sin SQL ni trazas. Ningún resultado vacío se clasifica por sí solo como ataque.

Snapshot: nuevas transacciones observan revocaciones confirmadas; una transacción RR iniciada puede conservar su snapshot. La revisión RBAC y la versión del catálogo no reflejan por sí solas cambios Memberships/Organizations. Pruebas revocan pertenencia durante una lectura, mantienen la decisión del snapshot y deniegan la siguiente pese a versiones iguales. RLS continúa aislando identidad/tenant; no es RLS por permiso empresarial ni defensa contra SQL arbitrario capaz de cambiar GUC. Control Center no recibe administración/selector ni privilegios implícitos.

## Authorization persistente — antecedente 2.3b

Addendum vigente 2.3b.1 / ADR-040: 2.3b fue aprobado con condiciones en ee6757e. Las comprobaciones de propietarios de `assign` se ejecutan **fuera** de cualquier transacción/conexión retenida de Authorization. Prechequeo read-only de replay, validación externa y escritura idempotente definitiva son fases separadas. UNIQUE sigue resolviendo carreras, incluso si las referencias fallan mientras otra operación confirma; solo después de resolver replay se rechaza una operación realmente nueva. No se amplían ACL ni se agregan cachés. La ventana TOCTOU entre validación y escritura permanece, y 2.4 debe revalidar disponibilidad antes de conceder acceso. Se mantienen los contratos del módulo propietario y las credenciales independientes. Los SQL materializados del benchmark son prototipos aislados, no un proveedor de authorization.access@1 ni una excepción nueva a la propiedad de datos.

Base `0d92c34` aprobada. ADR-039 agrega AuthorizationModule, propietario del esquema `authorization`; conserva Authentication → Identity → Memberships y Organizations como responsabilidades distintas. El módulo no tiene controlador, Guard ni evaluador funcional. Se exporta únicamente un servicio de operaciones técnicas; el puerto `authorization.access@1` es un contrato sin proveedor registrado. Ningún endpoint existente comienza a decidir permisos RBAC.

El catálogo global Permission/CatalogVersion solo se escribe desde migraciones. Role, RolePermission, RoleAssignment, TenantAuthorizationRevision, Operation y AuditEvent tienen tenant_id y ENABLE/FORCE RLS. El operador Authorization usa su propia credencial, sin lectura de tablas privadas Memberships/Organizations/sesiones. API solo lee concesiones dentro del contexto de tenant e identidad ya validado por los módulos existentes; no puede modificarlas ni leer auditoría/operaciones. BFF no recibe acceso a Authorization. Diagnóstico descubre los objetos reales y valida contratos explícitos, no un conteo fijo.

Las FK compuestas hacia Membership y OrganizationalUnit son una **excepción referencial controlada** a la propiedad de datos: pertenecen a Authorization, las crea el migrador, no conceden REFERENCES a runtime ni sustituyen validación ACTIVE/autorización. Los módulos comerciales seguirán usando contratos, no SQL a tablas privadas ajenas. La jerarquía fija GROUP→COMPANY→BRANCH no implica herencia de permisos: scopes exactos, grant-only, default deny; SUBTREE queda fuera de v1.

El wrapper técnico recibe tenant/actor/motivo/requestId/tipo normalizados, valida el operador y establece GUC LOCAL en la misma transacción y manager. RLS compara UUID contra un CASE seguro que devuelve NULL ante contexto ausente/malformado; frontera AS RESTRICTIVE sobre SELECT/INSERT/UPDATE, sin políticas generales de escritura. Triggers SECURITY INVOKER exigen operación pendiente, preservan historial, incrementan revisión y generan auditoría atómica. Ningún SECURITY DEFINER, BYPASSRLS o superusuario para resolver contexto. GUCs no autentican al proceso: SQL arbitrario con la misma conexión puede alterarlos.

Asignar valida referencias mediante contratos propios `MembershipsService.activeMembershipReference` y `OrganizationsService.availableScopeReference`, con DataSources separados y rol propio. No hay HTTP ni credenciales de esos operadores en Nest HTTP. Son snapshots diferentes de la transacción Authorization: existe TOCTOU y la fila almacenada no es una concesión efectiva por sí sola. En 2.4 la evaluación deberá revalidar transaccionalmente pertenencia, tenant, unidad y ancestros ACTIVE. La indisponibilidad del propietario se propaga como fallo, no se convierte en una concesión.

La fila de revisión por tenant serializa cambios RBAC de baja frecuencia; global y tenant usan bigint y se transportan como strings sin pérdida de precisión. `(catalog_version,tenant_revision)` no demuestra disponibilidad actual de Memberships/Organizations. No hay caché de decisiones; una futura caché nunca podrá reutilizar como vigente una comprobación antigua de disponibilidad.

El puerto permite `can`, `permissionsFor` y `scopesFor` con contexto nominal autenticado/validado y scope `{type,unitId}`. En 2.4 se diseñará su evaluación y consulta SQL de colecciones; para módulos externos se adaptará por HTTP en la fase de extensibilidad, autenticando servicio y contexto, sin aceptar un DTO arbitrario como autoridad. No hay parámetro resource genérico ni respuesta placeholder permisiva.

N-1 centraliza GUCs y lock_timeout LOCAL 8s en Organizations/Authorization, conservando defaults del rol y statement 20s. Error transitorio tipado/evento seguro distingue contención/conexión de REQUEST_ID_CONFLICT permanente. N-2 usa CURRENT_FINGERPRINT_VERSION compartida; N-3 aplica NOT VALID/VALIDATE al CHECK nuevo sobre operation poblada; N-4 divide fixture 20.000 en lotes. Detalles operativos y benchmark reproducible: OPERATIONS_RUNBOOK.md. Los apartados siguientes describen incrementos históricos; 2.4 y 2.5 siguen pendientes de autorización.

## Corrección acotada — 2.3a.1

2.3a y 2.3a.1 aprobados y cerrados en `0d92c34`. ADR-038 agregó migración décima sin modificar decisiones/migraciones históricas: validación PL/pgSQL separada del cast UUID, búsquedas indexables en triggers, UPDATE ligado al request LOCAL, auditoría sin default de legado y huellas versionadas v1/v2. Compatibilidad de replay existente comprobada antes/después de migración con Tenant y Company, sin reinterpretar resultados. Este apartado describe el antecedente; el contrato 2.3b está arriba.

Provisioning añade solo lock_timeout (runtime/BFF/operadores 1s, migrador 3s; bootstrap independiente). Los límites anteriores siguen vigentes. Lock timeout no acota ejecución de DDL una vez adquirido ni reemplaza ventana de mantenimiento; encolamiento, rollback y reintento están en OPERATIONS_RUNBOOK.md. Prueba de planes con 20.000 filas técnicas, SQL y roles efectivos, sin índices/hints añadidos para forzar el resultado; prueba de migración fallida preserva esquema/historial y se reintenta al liberar la contención. No hay RBAC ni nuevos endpoints.

## Hardening transversal — 2.3a

Base 2.2 aprobada en 9175804; 2.3a implementado pendiente de revisión. ADR-037 actualiza únicamente los contratos de escritura/auditoría y lectura Organizations y agrega límites/observabilidad/diagnósticos; no implementa RBAC. Los apartados 1.x/2.2 describen su estado histórico, extendido aquí.

Organizations recibe OrganizationOperation explícito con TrustedOperation compartido (actor/reason/requestId) y actorType técnico; no deriva autoridad del OS ni genera requestId por intento. Registro de operaciones global y eventos de auditoría separados, atómicos con la estructura/directorio. Resultado durable e idempotencia mediante PK + READ COMMITTED/ON CONFLICT/relectura; conflictos seguros y serialización de tenant antes del FK. Retención sin TTL. Actor USER_IDENTITY tiene FK preparada pero está rechazado hasta contar con flujo administrativo autorizado; legado no se reatribuye. No hay dependencia circular ni framework de auditoría.

getStructure requiere el EntityManager contextual suministrado, del mismo DataSource y con transacción activa, sin camino de transacción propia. El backend app comprueba identidad/tenant antes de leer. El operador conserva su contrato técnico bajo políticas propias. Los launchers mantienen credenciales operativas fuera de API/BFF, sin variables nuevas. Timeouts por rol se aplican al abrir conexiones nuevas, diferenciados de migrador/bootstrap. Correlation HTTP controlada y eventos estructurados mínimos no incluyen datos de identidad, secretos o SQL; los fallos de persistencia se clasifican antes de sanitizar respuestas.

db:diagnose usa el operador Organizations, nunca HTTP. Inventario de catálogo/columnas/ACL/políticas con excepciones no-RLS explícitas; dependencia SQL Memberships/directorio contrastada sin cambiar políticas. Comparación read-only completa de proyección y fuente bajo snapshot, sin repair/bypass. Runbook exige intervención administrativa revisada por incidente; reparación soportada y bootstrap desde cero verificado en CI se programan para 2.5.

Separar garantías: RLS actual protege pertenencias por identidad y tablas privadas por tenant; autorización entre empresas/sucursales del mismo tenant llegará en 2.4 y se verificará en 2.5. Archivos/procesos/jobs futuros siguen fuera de este alcance. Snapshot en curso no se revoca instantáneamente; GUC y timeouts no resisten SQL arbitrario del mismo rol. OPERATIONS_RUNBOOK.md/ADR-037 detallan matriz y limitaciones.

## Stack y distribución

- Monorepo pnpm Workspaces + Turborepo.
- apps/portal: Next.js App Shell para empresas.
- apps/control-center: Next.js administración exclusiva Innoview.
- apps/api: NestJS monolito modular para Core y módulos nativos.
- apps/worker: procesamiento asíncrono, eventos y reintentos.
- PostgreSQL con TypeORM como ORM inicial, Docker, TypeScript, tests automatizados, observabilidad.
- Tenant: límite lógico de aislamiento de una organización cliente. Deployment: instancia de ejecución que puede alojar uno o varios tenants.
- tenant_id y RLS aíslan tenants; la autorización del Core controla empresas y sucursales.
- Keycloak central vía OpenID Connect (Authorization Code + PKCE) para autenticación. Core gestiona autorización.
- Contrato OIDC en docs/OIDC.md, ADR-025/026. 1.2 integra BFF/JWT (ADR-027); packages/identity-bff tiene dos consumidores reales. 1.3 separa AuthenticationModule/IdentityModule y persiste UserIdentity (ADR-028); logout servidor y contrato v2 (ADR-029). 1.4 incorpora OrganizationsModule y su esquema organizations (ADR-030), exclusivamente mediante servicios internos, sin controllers. 1.5 incorpora MembershipsModule sin controllers, rol operativo y auditoría (ADR-031); consulta pretenant futura en ADR-032. 2.1 incorpora contexto transaccional de identidad y RLS Memberships (ADR-035); 2.2 agrega contexto tenant/RLS Organizations (ADR-036); autorización empresarial permanece pendiente.

## Paquetes previstos

- packages/contracts: contratos puros, esquemas, DTO y eventos independientes de frameworks.
- packages/platform-sdk: cliente de APIs y capacidades de plataforma.
- packages/ui-kit: temas, formularios, tablas y componentes compartidos.
- packages/auth: utilidades de validación de identidad/autorización (sin lógica específica de negocio).
- packages/transactions: UoW y adaptadores PostgreSQL/TypeORM.
- packages/events: Outbox, Inbox, workers y contratos de eventos.
- packages/capabilities: contratos, registry, resolver, proveedores.
- packages/observability y packages/config.

Evitar paquetes vacíos o abstracciones no justificadas: implementarlos progresivamente.

## Límites

- Core: identidad referenciada, tenants, grupos, empresas, sucursales, roles/alcances, módulos, configuraciones, auditoría.
- Módulos de negocio: sus propias reglas y datos, esquemas separados y migraciones propias.
- External apps: repositorios y bases propios, integración por API/adaptadores y OIDC/SSO cuando sea compatible.
- El consumidor depende de un contrato de capacidad (p. ej., party.directory v1); proveedor nativo mediante llamada interna, externo mediante adaptador HTTP.
- Resolver selecciona proveedor según tenant, módulo consumidor, alcance, versión y permisos.
- Uno principal por capacidad/contexto en MVP. Cambios de proveedor requieren plan de correspondencia/migración de datos.

## Ciclo de vida de módulos

Distinguir catálogo (Module/ModuleVersion), Deployment/ModuleDeployment, derecho comercial (Entitlement), habilitación (Activation), autorización de usuario y salud operativa. Monolito compartido despliega código de módulos estándar conjuntamente y los activa por tenant; instalaciones dedicadas configurables, inicialmente mismo artefacto.

## Transacciones y eventos

- UoW ACID compartido cuando participan módulos nativos en misma BD, a través de interfaces públicas; nunca acceder tablas ajenas.
- PostgreSQL EntityManager transaccional para operaciones participantes; proteger concurrencia.
- APIs externas fuera de transacciones locales; coordinar procesos distribuidos con estados y compensaciones.
- Outbox escrito en la misma transacción que el cambio de negocio; consumidores idempotentes y trazas por correlationId.

## Interfaz

Portal/App Shell dinámico, UI Kit, SDK y temas white-label configurables. Para aplicaciones externas: integración gradual de navegación, SSO, APIs y, si es viable, experiencia integrada. Evitar obligar a iframes o microfrontends para todo.

## Restricciones

Nunca abrir datos cross-tenant por estar en un mismo grupo, ni dar acceso por mostrar navegación. APIs, trabajadores, caché y archivos deben aislar contextos. Privilegios de Innoview Control Center separados de admins clientes.

## Organizations — 1.4

Organizations es dueño de Tenant, BusinessGroup, Company, Branch y OrganizationalUnit, sin consultar tablas de Identity. OU y registros concretos comparten UUID; nombre/estado/fechas tienen una única fuente en Tenant/OU. Padres tipados en Company/Branch, sin relación recursiva duplicada. FK compuestas, discriminadores generados y constraints diferidas garantizan integridad al commit; no equivalen a autorización ni RLS. Detalle en DATA_MODEL.md y ADR-030.

OrganizationsService exporta solo operaciones internas createTenant (incluye grupo/OU), createCompany, createBranch, getStructure y setStatus. Las escrituras son transaccionales, bloquean primero el tenant y no llaman servicios externos; las lecturas usan snapshot consistente. No hay framework de UoW nuevo, seeds de clientes ni endpoints por UUID. Los futuros consumidores deberán aportar contexto validado por Memberships y políticas Core antes de exponer datos; hoy ni siquiera un JWT válido habilita rutas Organizations.

```text
apps/api/src/organizations/
  organizations.module.ts
  organizations.service.ts
  organizations.types.ts
  organizations.spec.ts
  entities/
    tenant.entity.ts
    organizational-unit.entity.ts
    business-group.entity.ts
    company.entity.ts
    branch.entity.ts
    organization-record.ts
    index.ts
```

La clase base OrganizationRecord solo comparte columnas entre sus dos consumidores reales (Tenant/OU); no es otro módulo ni paquete. No hay controllers. La migración aditiva vive junto a las migraciones Core existentes: Organizations1792929600000.

## Memberships — 1.5

Corrección de aislamiento de credenciales (ADR-033): API dev/start usan launcher confiable que crea otro proceso con configuración permitida y entorno OS mínimo explícito. CLI Nest/watch y servidor compilado no cargan `.env` ni heredan credenciales operativas, BFF o testing. `main` valida configuración antes de importar NestJS; el DataSource exige rol app gestionado. Herramientas operativas permanecen separadas del servidor. README detalla lista, comandos y límite de seguridad del mismo usuario/archivos locales; no es un sandbox ni un despliegue de producción.

MembershipsModule es dueño de membership y audit_event en esquema memberships. Las referencias FK a Tenant.id y UserIdentity.id son contratos explícitos entre subdominios; el servicio no consulta sus tablas privadas ni duplica sus datos. Los identificadores proceden de referencias internas verificadas: en bootstrap son UUID seleccionados por el operador confiable y comprobados por FK; un futuro consumidor HTTP deberá derivar UserIdentity de la autenticación validada, nunca de email/body/claims de pertenencia.

El provider NestJS usa el DataSource de aplicación con SELECT únicamente sobre membership. Las operaciones internas de escritura requieren un DataSource separado de propósito membership, credencial operativa marcada y privilegios exactos; no se inyecta al runtime público. Bootstrap CLI fuera de HTTP emplea ese rol, sin credenciales administrativas/migrador ni roles empresariales. No hay controllers. ACTIVE→REVOKED terminal, unicidad histórica de pareja y auditoría en el mismo commit; detalle y operación en ADR-031/README.

Locks asesores transaccionales por request UUID y tenant serializan altas/revocaciones/primer bootstrap; UNIQUE y FK son las garantías finales en PostgreSQL. Contexto de auditoría local a la transacción y triggers SECURITY INVOKER, sin llamadas externas ni un UoW genérico. La identidad del actor OS y el rol DB permiten atribuir la operación técnica; no prueban criptográficamente quién controla la credencial/host.

### Consulta antes del contexto tenant — ADR-032, concretada parcialmente en 2.1

1. Validar JWT y resolver UUID Identity del principal autenticado, sin autoridad empresarial en claims.
2. Abrir transacción con contexto de identidad `SET LOCAL` exclusivamente desde backend confiable. La futura política SELECT FORCE RLS de Memberships filtrará por user_identity_id, incluso antes de tener tenant; ausencia de contexto debe devolver cero filas.
3. Consultar solo pertenencias propias, posiblemente de varios tenants. Esto no concede lectura de tablas empresariales ni devuelve estructuras privadas de Organizations.
4. Para el tenant candidato, releer pertenencia ACTIVE y disponibilidad organizacional mediante su contrato. Solo después fijar contexto tenant local de la operación. Políticas empresariales deberán exigir ambos contextos y pertenencia activa; un tenant_id aislado no demuestra acceso.

No requiere superusuario, BYPASSRLS ni SECURITY DEFINER. 2.1 implementa y prueba fail-closed, pool y concurrencia para Memberships por identidad. 2.2 extiende el contexto tenant y RLS Organizations; workers/permisos empresariales permanecen pendientes; no considerar el alcance Memberships como aislamiento general. Una revocación confirmada se observa en solicitudes nuevas por lectura de PostgreSQL, sin confiar en cachés/JWT/sesión. Una operación ya iniciada no se cancela automáticamente: conserva las garantías de su snapshot. El estado ACTIVE de Membership no sustituye el estado de Tenant ni RBAC futuro. No se implementan selector/contextos ni endpoints de organizaciones en 1.5.

## Contexto de navegación — 1.6

ContextModule compone contratos públicos concretos: Identity.findReference del principal JWT validado; Memberships.activeTenantReferences de esa identidad; Organizations.availableContextSummaries únicamente de esas referencias. Cada módulo consulta exclusivamente sus tablas. El coordinador aporta un mismo EntityManager ligado al DataSource app y a una transacción REPEATABLE READ/READ ONLY; los contratos rechazan un manager ajeno/no transaccional. Sin HTTP dentro de la transacción, escrituras, registro automático ni framework UoW genérico.

GET /context/options y POST /context/validate exponen solo UUID/nombre tenant y grupo, con autenticación obligatoria y cliente Portal. No son endpoints de estructuras privadas ni autorización empresarial. Una identidad no registrada obtiene lista vacía, sin creación; validar un candidato no disponible usa 404 uniforme. No se acepta user_identity_id en query/body. El grupo usa su único estado en OU GROUP, no otro estado duplicado en BusinessGroup. Detalle del contrato y respuestas en README/ADR-034.

El BFF Portal consulta API sin caché usando access token solo en servidor. La selección se guarda en columnas propias de su fila de sesión, con revisión CAS independiente del payload cifrado/version/lease de refresh. Cambiar/limpiar requiere Origin y CSRF; una revisión obsoleta no sobrescribe otra selección. GET de contexto comprueba pertenencia y estados mediante opciones actuales; invalida preferencias obsoletas con CAS para no borrar una selección concurrente distinta. No se mantienen transacciones SQL mientras se llama al Core/IdP. Logout borra la fila; ninguna respuesta tardía puede recrearla. Control Center no tiene columnas, rutas BFF ni selector de clientes.

Este contexto es una preferencia revocable de navegación, sin permisos, rol o acceso a empresas/sucursales. En 1.6 no había contexto PostgreSQL: 2.1 agrega únicamente contexto de identidad y RLS Memberships, descritos debajo. 2.2 agrega contexto tenant/RLS Organizations; la autorización empresarial permanece pendiente. La revocación confirmada afecta nuevas comprobaciones; solicitudes en curso conservan su snapshot.

## Contexto tenant y RLS Organizations — 2.2 (ADR-036)

2.1 aprobado en 55a1b29; 2.2 aprobado en 9175804. Esta sección concreta y extiende los alcances históricos descritos para 1.x/2.1. No introduce RBAC ni rutas empresariales.

El acceso pretenant no abre las tablas privadas. Organizations posee `tenant_directory`, proyección materializada mínima de UUID/nombres de tenant y grupo, más disponibilidad derivada. Triggers invocantes diferidos la sincronizan en el mismo commit; no se consulta una vista con privilegios de dueño. API recibe SELECT de esas cinco columnas exactas, sin grants futuros, y RLS por pertenencia ACTIVE de la identidad LOCAL. Las políticas Memberships se aplican a la subconsulta. Joins con estructuras privadas siguen cerrados sin tenant LOCAL. RLS no protege columnas automáticamente: por eso tax_id/empresas/sucursales no forman parte del directorio, y columnas nuevas no heredan acceso.

TenantReadTransactions, exportado por ContextModule, compone IdentityReadTransactions, Memberships.activeTenantReferences y Organizations.availableContextSummaries. Principal ya validado por AuthenticationModule → transacción app REPEATABLE READ/READ ONLY → limpieza LOCAL de ambos GUC → lookup identidad existente → identidad LOCAL → pertenencia ACTIVE y directorio disponible → tenant LOCAL → operación con el mismo manager. Candidato desconocido/ajeno/no disponible usa 404 uniforme. No creación automática, HTTP dentro de SQL, tenant desde cookies como autoridad, manager singleton ni UoW general. getStructure admite únicamente un manager activo del mismo DataSource para componer lecturas privadas dentro de ese scope; sigue siendo contrato interno, sin controller ni autorización empresarial.

Tenant, BusinessGroup, OU, Company y Branch exigen mediante ENABLE/FORCE RLS identidad con pertenencia vigente/directorio disponible y coincidencia textual de tenant LOCAL. Sin ambos contextos no hay lectura privada. Una identidad con dos pertenencias solo ve el tenant de esa transacción. Cada tabla tiene SELECT permisiva y un límite RESTRICTIVE FOR ALL WITH CHECK(false) para app. El migrador está sujeto a FORCE para DML; mantiene capacidad DDL confiable. No se convierten GUC a UUID: valores inválidos fallan cerrados sin errores de conversión. Confirmar/revertir retira ambos LOCAL antes de reutilizar conexiones.

OrganizationsService separa escrituras: provider HTTP conserva DataSource app, que no tiene DML y cuyo marcador se rechaza al escribir. El operador técnico obtiene un DataSource `organizations` independiente validado (sin roles elevados, memberships, ownership o DDL); credenciales nunca llegan a API/BFF. Políticas operativas propias preservan integridad/FK/estados y SELECT de los triggers invocantes. Grants exactos, sin DELETE, movimientos de claves, mutaciones generales o defaults de futuros objetos. Auditoría técnica invocante obligatoria e inmutable, con actor OS/DB/request y estados en el mismo commit; directorio/auditoría no admiten escritura directa. No hay administración delegada ni endpoints de operación.

Una revocación/estado confirmado cierra scopes nuevos, mientras operaciones iniciadas conservan su snapshot. GUC no es credencial: SQL arbitrario en la conexión puede falsificarlo. RLS no reemplaza Authentication, futuros Guards de permisos/alcances ni aislamiento de secretos. Pertenecer a un tenant no concede permisos sobre sus compañías/sucursales. No se publica lectura privada HTTP hasta implementar autorización empresarial. Migración, backfill y activación coordinados con parada/reinicio de servidores; sin borrado de volúmenes/sesiones ni SECURITY DEFINER. ADR-036 registra matriz, límites y pruebas.

## Identidad transaccional y primer RLS — 2.1 (histórico; extendido por 2.2)

IdentityReadTransactions, exportado por IdentityModule, proporciona un scope de lectura concreto: Principal ya validado por AuthenticationModule → transacción app REPEATABLE READ/READ ONLY → contexto LOCAL vacío → lookup UUID por Identity → set_config('innoview.user_identity_id', UUID, true) → operación con ese EntityManager. Sin identidad válida/local no ejecuta la operación. ContextModule usa ese scope, sin duplicar pertenencias ni consultas privadas cruzadas. No recibe UUID de identidad desde HTTP, no hace HTTP dentro de SQL ni crea un framework genérico de transacciones. El LOCAL desaparece en commit/rollback antes de devolver la conexión al pool.

memberships.membership tiene ENABLE/FORCE RLS. App SELECT ve únicamente user_identity_id de ese contexto; la comparación textual evita cast inseguro del GUC. Ausente/vacío/inválido/no canónico: cero filas. Una política restrictiva mantiene el límite ante otras SELECT permisivas; no habilita DML. Métodos de lectura Memberships aceptan manager del mismo DataSource; usar el manager global app sin contexto produce colección vacía/false. El operador tiene políticas propias de lectura completa/INSERT/UPDATE para bootstrap y revocación auditados, sin bypass ni nuevos grants. El dueño migrador no recibe política DML aunque conserva DDL. Matriz y límites completos en ADR-035/README.

RLS comprueba filas además de los filtros ORM, pero no autentica: cualquier código capaz de SQL arbitrario en esa conexión puede cambiar el GUC. Solo backend confiable establece LOCAL derivado del principal; no SET SESSION ni manager compartido entre solicitudes. FK/UNIQUE realizan comprobaciones internas globales incluso sobre filas ocultas; los SELECT de triggers siguen políticas del invocante. Operador ve el historial completo para que el bootstrap no se equivoque por filtrado. No hay SECURITY DEFINER, políticas de Organizations, GUC tenant ni RBAC. Las pruebas de 2.1 demuestran aislamiento RLS de pertenencias por identidad, no autorización empresarial ni aislamiento de las tablas organizacionales.
