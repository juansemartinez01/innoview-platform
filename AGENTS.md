# Innoview Platform — instrucciones permanentes para Codex

## Antes de trabajar

- Leer `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/DECISIONS.md` y `docs/IMPLEMENTATION_PLAN.md` según la tarea.
- Estas especificaciones son la fuente de verdad inicial. Ante ambigüedad, explicitar supuestos y proponer una decisión; no cambiar decisiones cerradas silenciosamente.
- Comenzar identificando alcance, archivos afectados, riesgos y pruebas. Implementar incrementos pequeños y verificables.
- No implementar todos los módulos del catálogo en el primer MVP.

## Reglas de arquitectura

- Monorepo pnpm Workspaces + Turborepo; NestJS, Next.js, TypeScript, PostgreSQL, Docker.
- Core separado de paquetes reutilizables y módulos de negocio.
- Monolito modular para Core y módulos nativos iniciales; aplicaciones externas mediante APIs/adaptadores.
- Cada módulo es dueño de sus datos; prohibido acceder a tablas privadas de otro módulo.
- Dependencias funcionales mediante contratos de capacidades; interfaces internas para nativos, HTTP adaptado para externos.
- El Core NO incorpora reglas de venta, stock, cuentas corrientes ni procesos verticales.
- Tenant es el límite lógico de aislamiento de una organización cliente; inicialmente contiene un grupo, varias empresas y sucursales. Deployment es una instancia de ejecución que aloja uno o varios tenants.
- TypeORM es el ORM inicial. RLS aísla tenants; el Core autoriza operaciones entre empresas y sucursales.
- Autenticación central con Keycloak/OIDC; autorización de negocio en Platform Core con roles, permisos y alcance organizacional.
- Módulos contratados, desplegados, habilitados, autorizados y operativos son conceptos diferentes.
- Los módulos nativos usan App Shell y UI Kit; externos pueden tener frontend independiente.
- Branding configurable por tenant/organización y white-label sin forks del Core.

## Seguridad y transacciones

- Nunca confiar en tenant, empresa o permisos declarados solo por el frontend.
- Datos tenant-owned con tenant_id, integridad referencial y Row-Level Security en PostgreSQL compartido; pruebas de aislamiento.
- Roles de aplicación sin BYPASSRLS ni privilegios de migración.
- Propagar contexto de tenant dentro de transacciones, sin fugas entre conexiones del pool.
- UoW local para transacciones ACID controladas entre módulos nativos en la misma BD; no llamar APIs externas dentro de una transacción.
- Eventos durables con Outbox, consumo idempotente, reintentos y observabilidad. Procesos distribuidos con coordinación explícita cuando aplique.
- Verificar controles de acceso desde backend en cada operación; delegación administrativa no permite escalamiento de privilegios.
- No incorporar secretos en código ni en documentación.

## Calidad y ejecución

- Escribir migraciones versionadas, pruebas unitarias de reglas y pruebas de integración con PostgreSQL real para RLS/UoW.
- Validar entradas/salidas y contratos, documentar APIs públicas y versionar eventos.
- No modificar decisiones arquitectónicas sin registrar el cambio en `docs/DECISIONS.md`.
- Tras cada tarea, explicar archivos cambiados, comandos ejecutados, pruebas y asuntos pendientes.
- No ejecutar despliegues de producción, migraciones destructivas ni crear infraestructura facturable sin aprobación explícita.

## Primer objetivo

Implementar el Foundation MVP en orden: monorepo y CI, OIDC, organizaciones, membresías, RBAC por alcance, RLS, portal mínimo, pruebas de aislamiento y módulo nativo de prueba.
