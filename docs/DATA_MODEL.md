# Modelo de datos — diseño inicial, no migración definitiva

## Authorization — persistencia implementada en 2.3b

2.3b.1 / ADR-040 no modifica el esquema: se conserva `assignment_member_scope` por evidencia real de consultas exactas y por membership; no hay migración adicional. `uq_role_tenant_name` es UNIQUE sin filtro de estado: un rol INACTIVE conserva reservado su nombre en ese tenant. Cambiar esa semántica exige decisión explícita. Una asignación ACTIVE puede referenciar un rol posteriormente INACTIVE; es historia válida y 2.4 debe excluirlo de concesiones efectivas. Los contadores/versiones no cambian en un replay ni prueban disponibilidad actual. La refactorización del prechequeo no implementa versionado histórico de huellas Authorization (D-5 sigue pendiente del cierre de Fase 2).

ADR-039 y migración 11 `AuthorizationModel1793037600000`; migraciones anteriores intactas. Esquema SQL `"authorization"`. No se agregan permisos implícitos a Identity, Membership o login.

| Tabla           | Identidad y restricciones                                                                                                                                    | Ciclo de vida                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| permission      | UUID estable, code UNIQUE/CHECK `modulo.recurso.accion`, owner_module consistente, description, replaced_by FK a otro Permission                             | ACTIVE→DEPRECATED terminal; código/UUID/owner inmutables; DELETE prohibido; fechas                         |
| catalog_version | singleton boolean PK true; revision bigint no negativa                                                                                                       | Incremento por cambio real de catálogo, misma transacción; seed técnico inicial 2                          |
| role            | UUID PK; tenant_id FK Tenant; UNIQUE(tenant_id,id), UNIQUE(tenant_id,name); description                                                                      | ACTIVE/INACTIVE, fechas; mismo nombre permitido entre tenants; sin rol global                              |
| role_permission | UUID; tenant_id/role_id FK Role; permission_id FK Permission; UNIQUE parcial ACTIVE(tenant_id,role_id,permission_id)                                         | ACTIVE→REVOKED terminal, revoked_at/revocation_reason coherentes; nueva concesión crea otra fila           |
| role_assignment | UUID; tenant_id/membership_id FK Membership; tenant_id/role_id FK Role; tenant_id/scope_unit_id/scope_type FK OrganizationalUnit                             | ACTIVE→REVOKED terminal; UNIQUE parcial ACTIVE por tenant/membership/role/unidad/tipo; fechas/motivo       |
| tenant_revision | tenant_id PK/FK Tenant, revision bigint ≥0                                                                                                                   | Cero inicial y suma atómica por cambio real; sin incrementos por replay/no-op                              |
| operation       | request_id UUID PK global del módulo; UNIQUE(tenant_id,request_id), tenant FK, tipo, huella SHA-256/version2, actor/tipo/motivo/source, result JSONB, fechas | Pendiente solo dentro de transacción; constraint diferida exige completitud; resultado histórico inmutable |
| audit_event     | UUID; tenant_id/operation_request_id FK compuesta; tipo/id registro, acción/estados, actor/tipo/motivo/source/db_actor/fecha                                 | Derivada por trigger, append-only; varios eventos posibles por operación; sin DELETE/UPDATE runtime        |

Las FK RoleAssignment usan exactamente `(tenant_id,membership_id)→memberships.membership(tenant_id,id)`, `(tenant_id,role_id)→authorization.role(tenant_id,id)` y `(tenant_id,scope_unit_id,scope_type)→organizations.organizational_unit(tenant_id,id,type)`, reutilizando `uq_unit_tenant_id_type`. ON DELETE RESTRICT, no cascadas destructivas. Impiden cruces de tenant/tipos incluso si RLS oculta la fila padre. No prueban pertenencia vigente ni disponibilidad ACTIVE. La dependencia referencial entre módulos nativos queda registrada como excepción controlada; roles runtime sin REFERENCES general.

Índices: asignaciones ACTIVE por `(tenant_id,membership_id,scope_type,scope_unit_id,role_id)`; índice completo `(tenant_id,id)` para operador incluyendo historia; unicidad parcial de concesiones activas, claves tenant/role y auditoría `(tenant_id,operation_request_id)`. Restricciones nuevas se crean directamente en tablas vacías. CHECK adicional technical_source en organizations.operation poblada: ADD CONSTRAINT NOT VALID y VALIDATE; PK/UNIQUE no usan esa sintaxis. TypeORM mapea las ocho entidades sin sincronizar su DDL; SQL versionado es dueño de FK/CHECK/índices/triggers.

Catálogo mínimo: UUID `a0000000-0000-4000-8000-000000000001` para foundation.probe.read y `…0002` para foundation.probe.write. Son referencias técnicas, sin endpoint protegido por esos permisos. Solo migrador cambia catálogo mediante migraciones; deprecados conservan referencias históricas pero no son efectivos ni aceptan nuevas asociaciones. Advisory lock transaccional coordina cambios globales y nuevas asociaciones.

Semántica v1: default deny, grant-only, sin DENY/SUBTREE; GROUP/COMPANY/BRANCH exactos sin herencia. Un nuevo nodo no recibe accesos automáticamente. En 2.4 se verificará la cadena fija de ancestros ACTIVE, pertenencia vigente y tenant. Desactivar un padre invalida disponibilidad sin reescribir concesiones. No confundir ACTIVE almacenado con decisión efectiva; tampoco selección del BFF con autorización.

RLS: seis tablas tenant-scoped ENABLE/FORCE, fronteras restrictivas con tenant UUID validado por CASE. Permission/CatalogVersion son excepciones globales explícitas, migrator-only para escritura. API solo SELECT de catálogo/concesiones/revisión con contexto validado y directorio disponible; asignaciones además visibles según Membership de la identidad contextual. Operador Authorization no tiene accesos a datos privados ajenos y usa sus propios Operation/AuditEvent. Revisión y auditoría solo se modifican por caminos derivados protegidos; no decisiones cacheadas. Diagnóstico inventaría todas las relaciones reales y clasifica cada objeto sin depender de cantidad fija.

## Organizaciones

- Tenant: límite lógico de aislamiento de una organización cliente. En MVP, un BusinessGroup por tenant.
- Deployment: instancia de ejecución que aloja uno o varios tenants; no equivale a Tenant.
- BusinessGroup: conjunto de empresas relacionadas.
- Company: entidad jurídica/operativa del grupo, incluye tax_id y estado.
- Branch: sede/unidad operativa dentro de Company.
- OrganizationalUnit: nodo tipado GROUP/COMPANY/BRANCH, tenant_id, padre válido y referencia al registro específico, usado para asignar alcances.
- Jerarquía válida solo GROUP → COMPANY → BRANCH; impedir ciclos y referencias entre tenants.

### Concreción 1.4 — ADR-030

Implementado y aprobado en 1.4: OrganizationalUnit guarda nombre/estado/fechas y cada BusinessGroup/Company/Branch comparte su UUID con una sola OU del tipo correcto. La pertenencia estructural reside únicamente en Company.business_group_id y Branch.company_id; el padre de OU se deriva al consultar. No se crea una columna parent_id independiente que pueda quedar desincronizada. Tablas del módulo: organizations.tenant, organizational_unit, business_group, company y branch.

Cada registro salvo Tenant lleva tenant_id. OU tiene PK UUID y UNIQUE(tenant_id,id) disponible para futuras referencias por alcance, además de UNIQUE(tenant_id,id,type) para sus subtipos. BusinessGroup/Company/Branch tienen PK(tenant_id,id) y unit_type GENERATED ALWAYS STORED constante GROUP/COMPANY/BRANCH. FK compuestas enlazan cada subtipo a su OU y cada empresa/sucursal a su padre del mismo tenant. UNIQUE(tenant_id) en BusinessGroup impone el máximo de un grupo; triggers de constraint diferidos exigen al commit exactamente uno y ninguna OU huérfana. La estructura acíclica por tipos sustituye una relación recursiva libre. UUID, pertenencia y relaciones son inmutables; RESTRICT y ausencia de DELETE runtime protegen dependencias.

Estado propio ACTIVE/INACTIVE/ARCHIVED en Tenant y OU. ACTIVE es inicial; ACTIVE↔INACTIVE, ambos→ARCHIVED y sin salida de ARCHIVED. Crear/reactivar requiere ancestros activos; desactivar un padre no copia estados a hijos. La disponibilidad efectiva futura considera todos los ancestros y permisos, no solo el estado propio. No se crean estados/roles derivados ni afiliaciones por esta jerarquía. Un cambio real de estado actualiza updated_at; repetir el mismo estado conserva la fecha.

| Entidad            | Campos propios                                                        | Referencias/estado                                                          |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Tenant             | id UUID, name, status, created_at, updated_at                         | No tiene tenant_id redundante ni Deployment; exactamente un grupo al commit |
| OrganizationalUnit | id UUID, tenant_id, type, name, status, created_at, updated_at        | FK Tenant; sin parent_id editable                                           |
| BusinessGroup      | tenant_id, id, unit_type generado                                     | FK OU GROUP; sin padre organizacional                                       |
| Company            | tenant_id, id, unit_type generado, business_group_id, tax_id opcional | FK OU COMPANY y BusinessGroup; nombre/estado en su OU                       |
| Branch             | tenant_id, id, unit_type generado, company_id                         | FK OU BRANCH y Company; nombre/estado en su OU                              |

Los nombres no son identificadores únicos. tax_id es opcional y opaco; todavía no hay política fiscal, normalización por país ni unicidad de CUIT/NIF. Los identificadores de referencia son UUID y claves compuestas, no nombres o documentos fiscales. No hay profile de Identity, user_id, Membership ni relaciones privadas entre módulos.

La migración Organizations1792929600000 crea cinco tablas, índices de padres y tres funciones SECURITY INVOKER con search_path fijo: guard_lifecycle, guard_typed_parent y assert_complete. Las comprobaciones diferidas son por registro/clave indexada, sin escanear árboles completos. Los servicios bloquean primero el tenant para serializar escrituras; getStructure usa REPEATABLE READ. Operaciones con SQL directo que violen la estructura tampoco pueden confirmar. No se permiten movimientos de nodos o eliminación desde runtime.

El esquema vacío se aprovisiona mediante bootstrap, conservando la política Foundation sin CREATE global para el migrador. Las expresiones STORED se registran de forma versionada en platform_meta.typeorm_metadata para que TypeORM no proponga reconstruirlas. Esa metadata y las migraciones no son accesibles por API. API: USAGE, SELECT/INSERT y UPDATE(status,updated_at) únicamente en Tenant/OU, sin privilegios generales de UPDATE/DELETE/DDL. El aprovisionamiento repetido elimina también grants por columna ajenos a esta política. BFF no puede leer organizations.

No hay endpoints Organizations ni aislamiento RLS en 1.4. Los filtros tenant de TypeORM son contratos internos y no una barrera de autorización: el rol compartido todavía puede leer varios tenants. Fase 2 deberá validar membresía/alcance, establecer contexto transaccional y probar RLS con estas constraints, funciones y rol real, incluyendo bootstrap. No reutilizar estos métodos como endpoints abiertos por UUID.

Verificación local 1.4: 22 resultados PostgreSQL (incluyen nueve subpruebas Organizations) y 26 de contrato OIDC/runtime: 48 resultados del runner, incluyendo pruebas principales agrupadoras. Creación de dos tenants, grupo único, unidades compartidas, asociaciones cruzadas/tipos/ciclos/huérfanos rechazados, rollback diferido, seis escritores concurrentes, estados, RESTRICT y privilegios efectivos. El aprovisionamiento elimina un grant UPDATE(name) agregado por la prueba en su base descartable. Reversión de las cuatro migraciones y reaplicación exclusivamente descartables; show/run repetidos y alineación metadata/entidades comprobados. Regresión login/identity/refresh/logout y HTTP 404 para rutas organizacionales con tokens reales. No prueba RLS ni autorización.

La migración local aditiva fue aplicada y consultada, y generate --check no produjo cambios. No hay seeds ni filas de clientes reales. TypeORM 1.1.2/pg 8.23.1 emiten una advertencia de deprecación al introspectar expresiones STORED en schemaBuilder.log; trace identifica consultas concurrentes internas del driver. No bloquea pruebas/generación y no se suprime: revisar compatibilidad antes de pg 9. Versiones/dependencias de Foundation conservadas.

## Identity

- Keycloak conserva cuentas, credenciales, MFA y sesiones del IdP.
- **UserIdentity implementada en 1.3:** tabla identity.user_identity, propiedad del módulo Identity. id UUID v4 interno (PK, gen_random_uuid nativo de PostgreSQL 18), issuer varchar(2048), external_subject varchar(255), created_at/updated_at timestamptz NOT NULL. Restricción PostgreSQL uq_user_identity_issuer_subject UNIQUE(issuer, external_subject), valores no vacíos. Los campos OIDC son exactos y sensibles a mayúsculas: no normalizar sub ni vincular por email.
- No hay email, contraseñas, tokens, perfil, tenant, roles ni membresías en UserIdentity. Resolución idempotente mediante INSERT ON CONFLICT DO NOTHING y lectura posterior con snapshot nuevo; conserva UUID y fechas al repetir. updated_at se inicializa al crear y no es last_login; aún no hay operaciones de modificación de identidad.
- La API solo obtiene la pareja desde un access token verificado. PUT /identity/me registra/resuelve y GET /identity/me consulta la identidad propia; /auth/me mantiene el principal OIDC sin persistencia. No existe búsqueda pública por UUID ajeno ni administración de identidades.
- El esquema vacío se aprovisiona con bootstrap, como los esquemas de Foundation; el migrador no recibe CREATE global sobre la base. La migración UserIdentity1792922400000 valida propiedad y crea la tabla/constraints. API solo tiene USAGE + SELECT/INSERT en identity, sin UPDATE/DELETE/DDL; BFF sin acceso. TypeORM registra la entidad con synchronize=false e installExtensions=false, sin instalar extensiones al arrancar.
- No hay FK al IdP externo. La PK UUID se referencia desde Memberships a partir de 1.5 mediante contrato explícito, sin duplicar issuer/sub ni consultar datos privados de Identity.
- Cambiar issuer/sub o recrear una cuenta Keycloak produce otra identidad. No hay linking por email ni transferencia automática de privilegios; una futura vinculación requerirá una decisión y un procedimiento auditado.
- Membership: implementada en 1.5; detalle debajo. Usa user_identity_id, nunca email ni UUID externo del IdP.
- Invitation: email objetivo, token hash, expiración, creador, consumida/revocada.
- ServiceAccount para integraciones máquina-máquina cuando se incorpore.

## Memberships — implementado en 1.5

| Objeto                  | Columnas y restricciones                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| memberships.membership  | UUID PK id; tenant_id UUID FK RESTRICT Organizations.Tenant.id; user_identity_id UUID FK RESTRICT Identity.UserIdentity.id; status ACTIVE/REVOKED; created_at/updated_at timestamptz; revoked_at timestamptz, revoked_by varchar(200), revoked_reason varchar(500) |
| Unicidad                | UNIQUE(tenant_id,user_identity_id) en todo el historial; UNIQUE(tenant_id,id) para futuras FK RoleAssignment por tenant, sin implementar esa entidad                                                                                                               |
| Estado                  | ACTIVE exige revocación nula; REVOKED exige fecha/actor/motivo. Guard DB impide reactivación y cambios de UUID/referencias/creación. Revocar no borra fila y no hay dos pertenencias históricas para la misma pareja                                               |
| Directorio              | Índice (user_identity_id,status), sin joins a datos privados. Puede devolver pertenencias de varios tenants; no equivale a acceso empresarial                                                                                                                      |
| memberships.audit_event | UUID PK; tenant_id/membership_id FK compuesta RESTRICT; CREATED/REVOKED; BOOTSTRAP/TRUSTED; actor, motivo, request_id UUID UNIQUE, rol DB efectivo, created_at. UNIQUE(membership_id,event_type), sin duplicar perfil/organización                                 |

Migración Memberships1792994400000 aditiva, sin modificar las anteriores. Esquema vacío aprovisionado explícitamente; tablas/funciones propiedad del migrador. synchronize=false. FK sin cascadas y ausencia de DELETE/TRUNCATE runtime conservan historial y referencias; triggers también impiden DELETE ordinario al migrador. El propietario sigue siendo privilegiado para DDL y no constituye una barrera frente a él. Reversión solo con protecciones descartables del CLI y sin CASCADE.

API tiene USAGE y SELECT sobre membership; sin escritura ni lectura de audit_event. Operador independiente: SELECT/INSERT sobre ambas tablas y UPDATE(status,updated_at) en membership; sin ownership/DDL/SUPERUSER/BYPASSRLS ni acceso a tablas Identity/Organizations/sesiones/historial. INSERT directo en auditoría se rechaza: únicamente el trigger de transición puede generarlo. El contexto técnico de auditoría es obligatorio; cambios materiales y evento son atómicos mediante SECURITY INVOKER. Nuevas tablas de Memberships no heredan grants amplios; repetir el aprovisionamiento reconcilia también ACL por columna.

Registrar ACTIVE es idempotente; registrar REVOKED falla. Revocar repetidamente conserva primer evento/fecha/motivo. Reactivación no permitida; habilitarla posteriormente requiere decisión explícita, migración y política auditada. Bootstrap solo crea la primera pertenencia de un tenant existente, con UUID Identity existente; reintento original devuelve estado actual, sin reactivar ni dar permisos. No confundir pertenencia con disponibilidad de Tenant/OU. Revocación se releerá desde DB en cada solicitud posterior; diseño pretenant compatible con RLS fail-closed documentado en ADR-032, implementado por etapas en 2.1/2.2 (ADR-035/036).

## Sesión Portal y contexto — 1.6

PortalContext1793001600000 añade selected_tenant_id UUID nullable y context_revision integer NOT NULL DEFAULT 0 a portal_sessions.sessions. CHECK de revisión no negativa y selección únicamente en filas kind=session. No son atributos de UserIdentity/Membership ni se duplican nombres/estados del tenant: cada respuesta mínima procede de una validación Core actual. No hay nuevas entidades empresariales, tablas, roles ni grants globales. Se conservan tokens y sesiones existentes; synchronize permanece false y no se modifican migraciones anteriores.

Sin FK entre la preferencia técnica y Organizations: conocer/persistir UUID no demuestra pertenencia, y no se acopla la retención de sesiones con el historial empresarial. Un UUID obsoleto se invalida al comprobarlo contra Core. Solo rol Portal accede a esa sesión; API, Control Center y operador Memberships no reciben permisos adicionales. Control Center mantiene su esquema anterior sin estas columnas.

La escritura CAS compara context_revision y vigencia de la sesión; incrementa únicamente esa revisión/selección. El payload cifrado de tokens, version y lease no se reescriben al seleccionar, y refresh no toca estas columnas. El borrado de sesión elimina contexto; una actualización tardía sin fila vigente no hace INSERT. Un GET que detecta selección ya no disponible limpia únicamente la revisión observada, reintentando si hubo otro cambio. No hay transacción abierta durante HTTP. Contratos, límites y fases futuras: README/ADR-032/034.

## RLS de Memberships — 2.1

MembershipIdentityRls1793008800000 no cambia entidades, datos, FK, historial ni ACL: habilita/ fuerza RLS en memberships.membership y crea cinco políticas explícitas por actor gestionado. API: SELECT de identidad transaccional más límite restrictivo; operador: SELECT completo, INSERT y UPDATE; migrador: sin política DML bajo FORCE. audit_event continúa protegido por sus ACL y triggers, sin RLS nuevo; Organizations lo incorpora posteriormente en 2.2 (ADR-036). No se crean roles ni permisos empresariales.

Identidad contextual: innoview.user_identity_id, establecido LOCAL por IdentityReadTransactions tras buscar UUID existente del principal autenticado. Comparación user_identity_id::text = NULLIF(current_setting(..., true),'') sin convertir el contexto a UUID. Cero filas si no coincide una identidad canónica; no errores de conversión ni consultas a Identity dentro de la política. El índice UUID/status y los filtros internos siguen vigentes; la política no reemplaza el filtro ACTIVE de selección ni oculta al usuario su propio historial REVOKED.

La visibilidad del operador preserva los SELECT invocantes del trigger de bootstrap y las escrituras/auditoría atómicas. FK/UNIQUE/PK conservan comprobaciones globales aunque el migrador no vea las filas por SELECT; RESTRICT no pierde eficacia. No considerar las restricciones un mecanismo de confidencialidad contra un escritor SQL confiable. Un rechazo de política revierte toda la operación y sus eventos. No modificar ni retirar RLS para operaciones habituales; usar el operador separado. Reversión del incremento solo en la fixture descartable mediante las protecciones existentes del CLI.

GUC no constituye prueba criptográfica de identidad: SQL arbitrario puede suplantarlo. LOCAL y el mismo EntityManager aseguran limpieza en código confiable; quedan prohibidos SET SESSION, contextos provenientes del frontend y managers globales para consultas dependientes de identidad. Pruebas reales de mismo backend/pool, rollback, concurrencia y SQL sin WHERE documentan el alcance; no demuestran RBAC ni RLS de Organizations. ADR-035.

## Organizations: directorio y aislamiento tenant — 2.2

OrganizationsTenantRls1793016000000 es la octava migración. Aditiva, preserva filas previas y sesiones; no modifica migraciones históricas. Hace backfill del directorio antes de activar FORCE; no inventa eventos de auditoría pasados. Upgrade con estructuras sintéticas de las siete migraciones anteriores, reversión/reaplicación solo descartable y aprovisionamiento repetido forman parte de las pruebas.

- `organizations.tenant_directory`: tenant_id UUID PK/FK RESTRICT a Tenant; tenant_name varchar(200); group_id UUID con FK compuesta RESTRICT a BusinessGroup(tenant_id,id); group_name varchar(200); available boolean. Cinco columnas, sin atributos privados. No es una nueva entidad empresarial ni fuente de estado: derivación transaccional de Tenant/BusinessGroup/OU GROUP, actualizada por triggers de constraint diferidos invocantes. available = Tenant ACTIVE y OU GROUP ACTIVE. La estructura completa y la proyección se confirman/revierten juntas.
- `organizations.audit_event`: UUID PK, tenant_id FK RESTRICT, record_id, record_type, action INSERT/STATUS_CHANGED, old_status/new_status, actor técnico host:usuario, db_actor, request_id UUID y created_at. No se duplican perfiles/contraseñas/datos comerciales. Solo transiciones materiales generan eventos; un estado repetido no los duplica. API/BFF no acceden. Solo los triggers de operación del rol independiente pueden insertar; UPDATE/DELETE/direct INSERT se rechazan. Registro técnico, no permiso ni identidad empresarial del actor.
- Cinco tablas privadas existentes: ENABLE/FORCE, app SELECT solo si tenant de fila coincide con innoview.tenant_id LOCAL y existe directorio disponible permitido a la identidad contextual. Directorio app SELECT exige Membership ACTIVE propia, aplicando también RLS Memberships. Límites restrictivos por tabla impiden que otra SELECT permisiva amplíe el acceso. Identidad/tenant ausentes, vacíos, no canónicos/malformados o ajenos → cero filas, sin cast de GUC a UUID. API no escribe, aunque tenga un contexto válido.
- Directorio app SELECT por columna, nunca grant de tabla/defaults. Una columna añadida no se filtra por SELECT *; sus joins con tablas privadas requieren políticas privadas. La API puede leer directorio de varios tenants propios antes de fijar uno, pero eso no autoriza leer sus compañías/sucursales.
- Operador Organizations: credencial propia y marcador gestionado; SELECT/INSERT explícitos en siete objetos; UPDATE(status,updated_at) en Tenant/OU y UPDATE derivado del directorio. Sin DELETE, DDL, ownership, memberships de roles, SUPERUSER/BYPASSRLS o acceso privado a otros módulos. Triggers previos conservan FK compuestas, correspondencia tipada, grupo único, integridad diferida y estados; no se permite retag/movimiento de referencias. Auditoría y directorio tienen también FORCE y políticas solo operativas según corresponda.

IdentityReadTransactions limpia ambos contextos LOCAL; TenantReadTransactions deriva UUID del principal validado, verifica pertenencia y disponibilidad y fija tenant LOCAL dentro del mismo snapshot/manager. No persiste esa autoridad en UserIdentity/JWT/BFF. El contexto desaparece con commit/rollback. Las operaciones empresariales futuras necesitarán permisos y alcance adicionales: RLS no concede acceso funcional a compañías/sucursales ni resiste SQL arbitrario que modifique los GUC. Revocación confirmada afecta scopes nuevos, no cancela snapshots iniciados. ADR-036.

## Operaciones Organizations y procedencia — 2.3a

OrganizationOperations1793023200000 agrega `organizations.operation`: request_id UUID PK global, tenant_id UUID FK RESTRICT nullable durante creación, operation_type, fingerprint SHA-256 v1, actor/actor_type, actor_identity_id UUID FK RESTRICT a Identity, reason, technical_source, result JSONB y fechas created_at/completed_at. La PK global impide reutilizar un request en otro tenant. Resultado, tenant y finalización son obligatorios al commit mediante constraint diferida; el operador solo puede finalizar una fila pendiente y no modificar historia completada ni eliminar. ENABLE/FORCE, políticas exactas y acceso exclusivo del operador Organizations; no hay grants a API/BFF ni al operador Memberships. Índice (tenant_id,created_at), sin defaults de objetos futuros ni limpieza automática.

Audit_event conserva los campos históricos y agrega actor_type, actor_identity_id FK, reason, technical_source y operation_request_id FK RESTRICT al registro. Eventos anteriores quedan LEGACY_UNVERIFIED, sin inventar FK/procedencia; actor y request antiguos no se cambian. Nuevos eventos técnicos provienen del registro abierto por el invocador confiable. USER_IDENTITY es representable con FK y CHECK de correspondencia, pero no puede usarse aún desde servicio/trigger. No se asume que un operador técnico sea una identidad empresarial. Una operación produce varios eventos, por lo que audit_event.request_id **no** es único; índice operation_request_id para trazabilidad.

Huella determinista y retorno original, incluidos timestamps; omisión/null/valor diferenciados y comparación adicional de contexto. READ COMMITTED y ON CONFLICT/relectura, lock tenant antes del FK y registro/datos/eventos/proyección atómicos. Retención durable: no reciclar request UUID ni borrar resultados sin política de archivo revisada; payload privado solo operador/backups. Memberships no cambia su modelo/historial/semántica; comparte solo el tipo mínimo de operación. Operación de actualización y límites: ADR-037/OPERATIONS_RUNBOOK.md. No se crean entidades RBAC.

## Corrección de operaciones — 2.3a.1

OperationTriggerHardening1793030400000, décima migración aditiva, agrega fingerprint_version smallint NOT NULL con CHECK 1/2: existentes=1, nuevas=2. No reescribe fingerprint/resultados/fechas ni eventos. V1 conserva su algoritmo histórico de primer nivel; v2 ordena objetos recursivamente mediante representación tipada, preserva arrays y distingue omisión/null/valor. El replay selecciona algoritmo por versión persistida, incluido Company v1 con taxFingerprint anidado. Nuevos escritores declaran v2; actualización coordinada sin mezclar código antiguo con DEFAULT 2.

Los triggers de escritura/auditoría validan GUC canónico antes de conversión UUID y comparan la PK UUID sin cast sobre request_id, preservando acceso a operation_pkey. UPDATE de operación exige coincidencia de OLD/NEW request_id y procedencia con contexto LOCAL; completadas siguen inmutables. audit_event.actor_type pierde su DEFAULT histórico y una constraint exige technical_source no vacío para eventos verificados; LEGACY_UNVERIFIED preexistentes se conserva. RLS, FK, grants y semántica Memberships no cambian. ADR-038/runbook documentan pruebas y restricciones de rollback.

## Authorization — posterior

- Permission: código estable namespaceado, p.ej. sales.orders.read; proviene de módulo.
- Role: tenant, nombre, rol interno, bandera de sistema.
- RolePermission: permisos del rol.
- RoleAssignment: membership, role, organizational_unit, tenant, estado; todas las FK deben imponer mismo tenant.
- Verificar tenant activo, membresía activa, módulo habilitado, permiso, alcance organizacional y política propia de negocio.
- Herencia de permisos hacia descendientes no es automática; se establece explícitamente por política.
- Admin del cliente puede invitar y asignar roles dentro de su autoridad delegada; no puede adquirir privilegios de Innoview.

## Aislamiento de datos

- Base PostgreSQL compartida en cloud, esquemas por módulo y tenant_id en datos tenant-owned.
- RLS con política USING/WITH CHECK, FORCE ROW LEVEL SECURITY, rol app sin bypass/superuser, tenant contextual establecido con set_config(..., true) dentro de transacción.
- Claves compuestas (tenant_id, id) y FK compuestas para impedir relaciones cross-tenant no válidas.
- RLS por tenant no resuelve permisos entre empresas y sucursales: son responsabilidad de la autorización del Core, con privacidad por defecto.
- RLS es defensa adicional, no sustituye autorización backend. Aislamiento también en cachés, archivos, jobs y API.
- Instalaciones dedicadas con PostgreSQL propio y la misma semántica de seguridad.

## Registro de módulos y capacidades (posterior al foundation)

Module, ModuleVersion, Deployment, ModuleDeployment, ModuleEntitlement, ModuleActivation, ModuleConfiguration; Capability, CapabilityContract, CapabilityProvider, CapabilityRequirement, CapabilityBinding.

## Reglas de migración

- TypeORM como ORM inicial; migraciones versionadas con su CLI. synchronize: false en todos los entornos; desarrollo también utiliza migraciones.
- Validar integridad de OrganizationalUnit y scopes antes de activar roles.
- Deshabilitar un módulo no elimina datos. Evitar borrados en cascada de datos financieros o históricos.
