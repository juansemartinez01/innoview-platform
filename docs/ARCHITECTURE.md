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
- Contrato OIDC en docs/OIDC.md, ADR-025/026. 1.2 integra BFF/JWT (ADR-027); packages/identity-bff tiene dos consumidores reales. 1.3 separa AuthenticationModule/IdentityModule y persiste UserIdentity (ADR-028); logout servidor y contrato v2 (ADR-029). 1.4 incorpora OrganizationsModule y su esquema organizations (ADR-030), exclusivamente mediante servicios internos, sin controllers. Membresías, autorización empresarial y RLS siguen pendientes.

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
