# Arquitectura técnica — v0.3

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
- Contrato OIDC en docs/OIDC.md, ADR-025/026. 1.2 integra BFF/JWT (ADR-027); packages/identity-bff tiene dos consumidores reales. 1.3 separa AuthenticationModule/IdentityModule y persiste UserIdentity (ADR-028); logout servidor y contrato v2 (ADR-029). 1.4 incorpora OrganizationsModule y su esquema organizations (ADR-030), exclusivamente mediante servicios internos, sin controllers. 1.5 incorpora MembershipsModule sin controllers, rol operativo y auditoría (ADR-031); consulta pretenant futura en ADR-032. Autorización empresarial y RLS siguen pendientes.

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

### Consulta antes del contexto tenant — diseño para Fase 2

1. Validar JWT y resolver UUID Identity del principal autenticado, sin autoridad empresarial en claims.
2. Abrir transacción con contexto de identidad `SET LOCAL` exclusivamente desde backend confiable. La futura política SELECT FORCE RLS de Memberships filtrará por user_identity_id, incluso antes de tener tenant; ausencia de contexto debe devolver cero filas.
3. Consultar solo pertenencias propias, posiblemente de varios tenants. Esto no concede lectura de tablas empresariales ni devuelve estructuras privadas de Organizations.
4. Para el tenant candidato, releer pertenencia ACTIVE y disponibilidad organizacional mediante su contrato. Solo después fijar contexto tenant local de la operación. Políticas empresariales deberán exigir ambos contextos y pertenencia activa; un tenant_id aislado no demuestra acceso.

No requiere superusuario, BYPASSRLS ni SECURITY DEFINER. Se implementará y probará fail-closed, pool, workers y concurrencia en Fase 2; hoy no hay esas políticas y el rol compartido todavía puede leer otras pertenencias por SQL. Una revocación confirmada se observa en solicitudes nuevas por lectura de PostgreSQL, sin confiar en cachés/JWT/sesión. Una operación ya iniciada no se cancela automáticamente: conserva las garantías de su snapshot. El estado ACTIVE de Membership no sustituye el estado de Tenant ni RBAC futuro. No se implementan selector/contextos ni endpoints de organizaciones en 1.5.
