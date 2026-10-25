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
- [x] 0.3 — Calidad y CI: lint, formato, política común de TypeScript y workflow. Aprobado por el usuario; resultados y política en FOUNDATION.md.
- [x] 0.4 — Entorno Docker PostgreSQL/Keycloak y bases separadas. Salud, conexiones y persistencia verificadas en Docker Desktop/PowerShell; evidencia en FOUNDATION.md. Aprobado por el usuario antes de 0.5.
- [x] 0.5 — TypeORM/pg, roles, migraciones y PostgreSQL real. Aprobado por el usuario; evidencia en FOUNDATION.md.
- [x] 0.6 — Verificación integral desde clon limpio, aplicaciones, persistencia, seguridad y documentación. Aprobado; Fase 0 oficialmente cerrada por el usuario.

0.1–0.6 aprobados. Fase 0 oficialmente cerrada el 2026-10-25; evidencia en FOUNDATION.md. 1.1 aprobado; Fase 1 autorizada exclusivamente hasta 1.2. Contrato/runtime en OIDC.md; módulos posteriores como análisis en PHASE_1_PREPARATION.md.

### Fase 1 — Identidad y organizaciones

- [x] 1.1 — Realm innoview, clientes Code + PKCE separados, issuer/audiencias/scopes, aprovisionamiento sin overwrite, contrato de sesiones, librerías y pruebas OIDC. Aprobado por el usuario en 6de8c38; ADR-025/026 y OIDC.md.
- [x] 1.2 — Integración runtime: login/logout en ambos Next.js, sesiones técnicas HttpOnly/servidor cifrado, CSRF, refresh serializado, Guard JWT y GET /auth/me. Pruebas reales PostgreSQL/Keycloak/HTTP. Pendiente revisión antes de continuar; ADR-027 y OIDC.md.
- [ ] 1.3 — Identity local: UserIdentity referenciada por issuer/sub y contrato público de identidad; sin contraseñas locales ni autorización implícita.
- [ ] 1.4 — Organizations: Tenant, BusinessGroup, Company, Branch y OrganizationalUnit, migraciones/constraints y contratos por módulo.
- [ ] 1.5 — Memberships: identidad/tenant, estados y bootstrap controlado. Acordar previamente consulta de membresías con el futuro aislamiento fail-closed.
- [ ] 1.6 — Contexto organizacional: consulta de organizaciones accesibles y selector, sin confiar en el contexto del frontend.
      **Aceptación final:** identidad central y relaciones organizacionales verificables. La autorización empresarial y RLS siguen en Fase 2; no declarar acceso multi-tenant seguro antes de incorporarlos.

Los números 1.2–1.6 formalizan la secuencia solicitada: primero runtime, luego identidad local y organizaciones. El modelo aprobado no cambia. Solo 1.1/1.2 están implementados. Recomendación posterior a la revisión: acordar 1.3 con contrato de identidad y bootstrap, sin adelantar organizaciones/RBAC/RLS. No iniciado.

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
