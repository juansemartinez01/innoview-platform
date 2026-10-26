# Modelo de datos — diseño inicial, no migración definitiva

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

Registrar ACTIVE es idempotente; registrar REVOKED falla. Revocar repetidamente conserva primer evento/fecha/motivo. Reactivación no permitida; habilitarla posteriormente requiere decisión explícita, migración y política auditada. Bootstrap solo crea la primera pertenencia de un tenant existente, con UUID Identity existente; reintento original devuelve estado actual, sin reactivar ni dar permisos. No confundir pertenencia con disponibilidad de Tenant/OU. Revocación se releerá desde DB en cada solicitud posterior; diseño pretenant compatible con RLS fail-closed documentado en ADR-032, todavía no implementado ni validado como aislamiento.

## Sesión Portal y contexto — 1.6

PortalContext1793001600000 añade selected_tenant_id UUID nullable y context_revision integer NOT NULL DEFAULT 0 a portal_sessions.sessions. CHECK de revisión no negativa y selección únicamente en filas kind=session. No son atributos de UserIdentity/Membership ni se duplican nombres/estados del tenant: cada respuesta mínima procede de una validación Core actual. No hay nuevas entidades empresariales, tablas, roles ni grants globales. Se conservan tokens y sesiones existentes; synchronize permanece false y no se modifican migraciones anteriores.

Sin FK entre la preferencia técnica y Organizations: conocer/persistir UUID no demuestra pertenencia, y no se acopla la retención de sesiones con el historial empresarial. Un UUID obsoleto se invalida al comprobarlo contra Core. Solo rol Portal accede a esa sesión; API, Control Center y operador Memberships no reciben permisos adicionales. Control Center mantiene su esquema anterior sin estas columnas.

La escritura CAS compara context_revision y vigencia de la sesión; incrementa únicamente esa revisión/selección. El payload cifrado de tokens, version y lease no se reescriben al seleccionar, y refresh no toca estas columnas. El borrado de sesión elimina contexto; una actualización tardía sin fila vigente no hace INSERT. Un GET que detecta selección ya no disponible limpia únicamente la revisión observada, reintentando si hubo otro cambio. No hay transacción abierta durante HTTP. Contratos, límites y fases futuras: README/ADR-032/034.

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
