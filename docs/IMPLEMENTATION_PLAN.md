# Plan de implementación — Foundation MVP

## Método

Desarrollo por incrementos verticales con pruebas, no implementación simultánea del catálogo. Cada etapa produce algo ejecutable y revisión de riesgos; los 'sprints' son fases, no estimaciones.

### Fase 0 — Fundaciones

- [x] Crear monorepo pnpm + Turborepo, apps/portal, apps/control-center, apps/api (0.2).
- [x] PostgreSQL Docker para app y Keycloak (bases separadas, 0.4).
- [x] Configurar TypeScript, lint, formato, CI, migraciones y test real contra PostgreSQL (0.3/0.5).
      **Aceptación:** se levanta stack local, CI verde, migración reversible de prueba.

#### Incrementos de Fase 0

- [x] 0.1 — Acuerdos mínimos: ADR-023/024, versiones, comandos, estrategia de migraciones y riesgos en FOUNDATION.md y DECISIONS.md.
- [x] 0.2 — Inicialización: Git local, tres aplicaciones mínimas, lockfile, build/tipos y comprobaciones HTTP en desarrollo y tras build.
- [x] 0.3 — Calidad y CI: lint, formato, política común de TypeScript y workflow. 0.1/0.2 aprobados por el usuario; resultados y política en FOUNDATION.md. Validar 0.3 antes de avanzar.
- [x] 0.4 — Entorno Docker PostgreSQL/Keycloak y bases separadas. Salud, conexiones y persistencia verificadas en Docker Desktop/PowerShell; evidencia en FOUNDATION.md. Aprobado por el usuario antes de 0.5.
- [x] 0.5 — TypeORM/pg, roles, migraciones y PostgreSQL real. Evidencia en FOUNDATION.md; pendiente revisión antes de 0.6.
- [ ] 0.6 — Verificación integral del stack y documentación final.

0.1 y 0.2 verificados el 2026-10-24; evidencia en FOUNDATION.md. La aceptación completa de Fase 0 sigue pendiente; build verde no equivale a CI configurada.

### Fase 1 — Identidad y organizaciones

- [ ] Keycloak realm central, clientes OIDC con Authorization Code + PKCE, secretos por entorno.
- [ ] Next.js login/logout, sesión HttpOnly y validación de tokens en NestJS.
- [ ] Migraciones tenant/group/company/branch/organizational_unit/user identity/membership.
- [ ] API para consultar organizaciones accesibles y selector de contexto.
      **Aceptación:** mismo usuario central puede pertenecer a tenants distintos sin mezclar permisos.

### Fase 2 — Autorización y aislamiento

- [ ] Permisos, roles, role_permissions, role_assignments, policies y Guards.
- [ ] Validar jerarquía de OU y FKs por tenant.
- [ ] RLS fail-closed en tablas privadas, rol de app sin BYPASSRLS, set_config transaccional.
- [ ] Pruebas de aislamiento entre tenants, grupos, empresas y sucursales.
      **Aceptación:** intento de acceso cross-tenant/cross-scope rechazado también por API directa.

### Fase 3 — Administración delegada

- [ ] Invitaciones con token de un solo uso, expiración y auditoría.
- [ ] UI administrador de empresa: usuarios, membresías, roles y permisos permitidos.
- [ ] Pruebas de escalamiento de privilegios y revocación.
      **Aceptación:** admin cliente incorpora y revoca usuarios sin acceso a plataforma Innoview.

### Fase 4 — Extensibilidad mínima

- [ ] Registro básico de módulo y habilitación por tenant.
- [ ] Módulo nativo mínimo con rutas, permisos y navegación.
- [ ] White-label básico de dos tenants.
- [ ] Primera prueba de contrato party.directory con proveedor nativo y proveedor externo ficticio.
      **Aceptación:** un módulo nativo habilitado en un tenant no puede utilizarse en otro no habilitado; ejemplo de capacidad intercambiable funciona.

## No incluido por ahora

ERP completo, marketplace autoservicio, facturación fiscal, Kafka, workflow visual, motor universal de sagas, instalación arbitraria de plugins en producción.

## Criterio de terminado por historia

Cambio implementado, migración versionada si aplica, validación de seguridad por tenant/rol, pruebas automatizadas, docs actualizadas, revisión de dependencias y resultados de tests reportados.

## Primera tarea para Codex

Analizar documentación, proponer estructura mínima concreta de repositorio y plan de Fase 0. No ejecutar grandes cambios hasta confirmar interfaces y dependencias.
