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

0.1–0.6 aprobados. Fase 0 oficialmente cerrada el 2026-10-25; evidencia en FOUNDATION.md. 1.1–1.4 aprobados; Fase 1 autorizada exclusivamente hasta 1.5. Contrato/runtime en OIDC.md; Organizations/Memberships en DATA_MODEL.md y ADR-030/031/032.

### Fase 1 — Identidad y organizaciones

- [x] 1.1 — Realm innoview, clientes Code + PKCE separados, issuer/audiencias/scopes, aprovisionamiento sin overwrite, contrato de sesiones, librerías y pruebas OIDC. Aprobado por el usuario en 6de8c38; ADR-025/026 y OIDC.md.
- [x] 1.2 — Integración runtime: login/logout en ambos Next.js, sesiones técnicas HttpOnly/servidor cifrado, CSRF, refresh serializado, Guard JWT y GET /auth/me. Aprobado en 6f73da9; mejora del retorno SSO completada en 1.3. ADR-027 y OIDC.md.
- [x] 1.3 — Identity local y corrección logout SSO. Aprobado en ec8273f; ADR-028/029 y OIDC.md.
- [x] 1.4 — Organizations: cinco entidades y servicios internos transaccionales sin endpoints. Padres derivados, FK compuestas, grupo único, correspondencia tipada, constraints diferidas, estados y ACL restringidas. Aprobado en e0dde1d; DATA_MODEL.md y ADR-030.
- [x] 1.5 — Memberships interno: UUID, FK Tenant/Identity RESTRICT, pareja única y clave compuesta por tenant; ACTIVE→REVOKED terminal, concurrencia/idempotencia, auditoría transaccional y bootstrap CLI explícito con rol operativo independiente. API solo SELECT, sin endpoints administrativos ni autoafiliación. Consulta pretenant futura fail-closed acordada en ADR-032, no RLS implementado. Migración y pruebas PostgreSQL/Keycloak descartables; ADR-031/032. Implementado, pendiente revisión antes de 1.6.
- [ ] 1.6 — Contexto organizacional: consulta de organizaciones accesibles y selector, sin confiar en el contexto del frontend.
      **Aceptación final:** identidad central y relaciones organizacionales verificables. La autorización empresarial y RLS siguen en Fase 2; no declarar acceso multi-tenant seguro antes de incorporarlos.

Solo 1.1–1.5 están implementados. Revisar 1.5 antes de comenzar 1.6; ninguna pertenencia concede permisos empresariales ni privilegios Innoview. El siguiente incremento deberá derivar identidad exclusivamente del principal autenticado, releer pertenencia activa y verificar disponibilidad de organizaciones mediante contratos internos antes de seleccionar contexto. Sin endpoints de administración de membresías, RBAC, RLS ni selector todavía. Las pruebas 1.4/1.5 validan integridad y ACL, no aislamiento autorizado multi-tenant.

Verificación local 1.5 (2026-10-26): lint, formato, typecheck y build satisfactorios; 62 resultados de prueba aprobados (34 persistencia/Organizations/Memberships y 28 runtime/OIDC). Bootstrap CLI real, concurrencia, FK, ACL, auditoría y reversión/reaplicación en bases generadas descartables; migración aditiva aplicada a la base local conservando datos/volúmenes y sin crear pertenencias reales. generate --check sin diferencias. Se corrigió el vencimiento del token de la herramienta administrativa de pruebas Keycloak: ahora readquiere credenciales antes de expirar y tiene prueba real con token de un segundo. No cambia sesiones ni contrato OIDC de aplicaciones. Permanece la advertencia conocida de introspección concurrente TypeORM/pg; no es un fallo de tests ni evidencia RLS. La revisión debe incluir la ejecución CI del commit publicado.

### Fase 2 — Autorización y aislamiento

- [ ] Permisos, roles, role_permissions, role_assignments, policies y Guards.
- [x] Jerarquía de OU y FK por tenant implementadas en 1.4 como integridad. Revalidar su interacción con RLS/UoW en Fase 2.
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
