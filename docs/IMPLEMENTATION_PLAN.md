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

0.1–0.6 aprobados. Fase 0 oficialmente cerrada el 2026-10-25; evidencia en FOUNDATION.md. 1.1–1.6 aprobados, incluido hardening 27cb6c7. Fase 1 oficialmente completada tras revisar b04cd26/e2aaf61; Fase 2 autorizada exclusivamente hasta 2.2. Contrato/runtime en OIDC.md; Organizations/Memberships/contexto en DATA_MODEL.md y ADR-030/031/032/033/034.

### Fase 1 — Identidad y organizaciones

- [x] 1.1 — Realm innoview, clientes Code + PKCE separados, issuer/audiencias/scopes, aprovisionamiento sin overwrite, contrato de sesiones, librerías y pruebas OIDC. Aprobado por el usuario en 6de8c38; ADR-025/026 y OIDC.md.
- [x] 1.2 — Integración runtime: login/logout en ambos Next.js, sesiones técnicas HttpOnly/servidor cifrado, CSRF, refresh serializado, Guard JWT y GET /auth/me. Aprobado en 6f73da9; mejora del retorno SSO completada en 1.3. ADR-027 y OIDC.md.
- [x] 1.3 — Identity local y corrección logout SSO. Aprobado en ec8273f; ADR-028/029 y OIDC.md.
- [x] 1.4 — Organizations: cinco entidades y servicios internos transaccionales sin endpoints. Padres derivados, FK compuestas, grupo único, correspondencia tipada, constraints diferidas, estados y ACL restringidas. Aprobado en e0dde1d; DATA_MODEL.md y ADR-030.
- [x] 1.5 — Memberships interno aprobado en 5dc4d7e y hardening aprobado en 27cb6c7; incremento oficialmente cerrado. UUID, FK Tenant/Identity RESTRICT, pareja única y clave compuesta; revocación terminal, auditoría y bootstrap operativo independiente. API solo SELECT y credenciales mínimas. ADR-031/032/033; sin RLS ni autorización empresarial.
- [x] 1.6 — Contexto organizacional y selector mínimo Portal aprobados en b04cd26/e2aaf61; Fase 1 oficialmente completada. GET /context/options y POST /context/validate autentican y leen contratos de Identity/Memberships/Organizations con snapshot read-only, sin autoaltas. BFF guarda preferencia/revisión CAS en sesión técnica Portal, revalida disponibilidad y protege cambios con CSRF/Origin. Sin selector Control Center, RBAC ni RLS. Pruebas PostgreSQL/Keycloak y navegador Chromium; ADR-034.
      **Aceptación final:** identidad central y relaciones organizacionales verificables. La autorización empresarial y RLS siguen en Fase 2; no declarar acceso multi-tenant seguro antes de incorporarlos.

1.1–1.6 aprobados; Fase 1 cerrada oficialmente por el usuario. Identidad central/local, estructura organizacional, pertenencias y selector técnico están validados. No equivalen a permisos empresariales ni aislamiento general de datos. Fase 2 comienza exclusivamente con 2.1; RBAC, contexto tenant y RLS Organizations requieren incrementos posteriores revisados.

Verificación local 1.6: instalación congelada, lint, formato, typecheck y builds correctos; 79 resultados aprobados (36 PostgreSQL y 43 entorno/runtime/OIDC/navegador, incluidos agrupadores). Chromium real verifica login, selección/cambio/recarga/limpieza, usuario sin opciones y ausencia de selector en Control Center. Pruebas de snapshot compartido, lectura sin alta, tres tenants/dos identidades y usuario sin membresías, estados, 401/404, campos/cookies manipulados, CSRF/Origin, revocación posterior, CAS con refresh/logout y aislamiento de secretos. Reversión/reaplicación de seis migraciones exclusivamente descartable; migración aditiva local aplicada sin seeds ni pérdida de volúmenes, generate --check sin diferencias. CI del commit publicado debe verificarse antes de la revisión. Persiste el aviso conocido TypeORM/pg de introspección, sin suprimirlo ni actualizar dependencias para ocultarlo. La primera ejecución CI se canceló para diagnosticar una descarga apt excesivamente lenta del mirror Azure antes de iniciar las pruebas. Se fija Ubuntu 24.04 y se instala solo Chromium, con verificación de arranque obligatoria y timeout, evitando actualizaciones OS innecesarias.

Revisión funcional 1.5 aprobada en 5dc4d7e y hardening correctivo aprobado en 27cb6c7: cierre oficial confirmado por el usuario. ADR-033 documenta el riesgo de credenciales privilegiadas heredadas, su corrección mediante launchers y sus límites. Esa separación permanece obligatoria en 1.6.

Validación correctiva local: 68 resultados aprobados (34 de persistencia/Organizations/Memberships y 34 de entorno/runtime/OIDC, incluyendo agrupadores), lint/formato/typecheck/build satisfactorios. Comandos pnpm dev/start reales, no un servidor alternativo del harness; evidencia de nombres de variables sin valores, rol app activo y sin escritura Memberships. Bootstrap operativo y ambos BFF conservan su separación. Se deshabilita shell en watch y se fija el ejecutable Node del launcher para sus hijos. La prueba de renovación administrativa usa tres segundos para evitar redondeo de expires_in a cero, manteniendo expiración real. RLS y contexto organizacional siguen sin implementarse.

Verificación local 1.5 (2026-10-26): lint, formato, typecheck y build satisfactorios; 62 resultados de prueba aprobados (34 persistencia/Organizations/Memberships y 28 runtime/OIDC). Bootstrap CLI real, concurrencia, FK, ACL, auditoría y reversión/reaplicación en bases generadas descartables; migración aditiva aplicada a la base local conservando datos/volúmenes y sin crear pertenencias reales. generate --check sin diferencias. Se corrigió el vencimiento del token de la herramienta administrativa de pruebas Keycloak: ahora readquiere credenciales antes de expirar y tiene prueba real con token de un segundo. No cambia sesiones ni contrato OIDC de aplicaciones. Permanece la advertencia conocida de introspección concurrente TypeORM/pg; no es un fallo de tests ni evidencia RLS. La revisión debe incluir la ejecución CI del commit publicado.

### Fase 2 — Autorización y aislamiento

- [x] 2.1 — Aprobado en 55a1b29: contexto transaccional de identidad y RLS Memberships. IdentityReadTransactions deriva UUID del principal ya autenticado y establece GUC LOCAL en un mismo EntityManager REPEATABLE READ/READ ONLY. ENABLE/FORCE RLS, políticas app por identidad y operador separado, sin grants adicionales/SECURITY DEFINER/BYPASSRLS. Bootstrap/auditoría/selector conservados; pruebas SQL sin filtros, pool real de una conexión, rollback, concurrencia y JWT. ADR-035. 2.2 autorizado por el usuario tras esa revisión.
- [x] 2.2 — Contexto tenant transaccional y RLS Organizations implementados, pendientes de revisión. Directorio pretenant de cinco columnas sujeto a pertenencia; cinco tablas privadas con ENABLE/FORCE y límite restrictivo por tenant/identidad. Operador Organizations separado, auditoría atómica y sincronización diferida. Migración aditiva probada con datos sintéticos previos, sin cambios de sesiones ni migraciones históricas. ADR-036. No avanzar a 2.3/RBAC.

Verificación local 2.2: instalación congelada, lint, formato, typecheck y build satisfactorios. **99 resultados aprobados: 55 PostgreSQL y 44 entorno/OIDC/runtime/Chromium**, incluidos agrupadores; cero fallos, omisiones o cancelaciones. Diez subpruebas nuevas de Organizations RLS: pretenant, SQL/joins sin WHERE, tres tenants/dos identidades más una vacía, contextos inválidos, límites restrictivos/columnas futuras, conexión física única con ambos LOCAL limpios tras commit/rollback, treinta operaciones concurrentes, auditoría/ACL operativas, defaults privados y revocación/estados. Upgrade real desde siete migraciones con estructura sintética; ocho migraciones revertidas/reaplicadas solo descartables. Base local actualizada aditivamente sin fixtures ni borrado de datos/volúmenes/sesiones; db:show confirma ocho aplicadas y generate --check no encuentra diferencias. Catálogo local confirma ENABLE/FORCE en siete tablas Organizations, app sin escrituras por tabla/columna y operador sin flags elevados. Continúa la advertencia conocida de introspección TypeORM/pg; no se suprime ni se presenta como fallo de aislamiento. Verificar ejecución GitHub Actions del commit publicado antes de aprobar el incremento. No es evidencia de autorización empresarial, permisos entre compañías/sucursales ni cierre de Fase 2.

Verificación local 2.1: 89 resultados aprobados (45 PostgreSQL y 44 entorno/runtime/OIDC/navegador, incluidos agrupadores). Se conserva la regresión anterior y se agrega aislamiento RLS por identidad con SQL directo/joins, contextos ausentes/inválidos, pool de una conexión y pg_backend_pid reutilizado tras commit/rollback, 36 transacciones concurrentes y JWT reales alternados. Bootstrap CLI real/idempotencia y auditoría continúan bajo las políticas; una violación RLS revierte escrituras previas y eventos en el mismo bloque. FK global con filas ocultas, políticas restrictivas ante otra SELECT permisiva, ausencia de privilegios operativos app y reconciliación de aprovisionamiento verificadas. Siete migraciones revertidas/reaplicadas solo en base descartable; comprobar CI del commit publicado antes de revisar. Esto no prueba autorización empresarial ni aislamiento Organizations.

- [ ] Permisos, roles, role_permissions, role_assignments, policies y Guards.
- [x] Jerarquía de OU y FK por tenant implementadas en 1.4 como integridad. Revalidar su interacción con RLS/UoW en Fase 2.
- [x] RLS fail-closed Memberships/Organizations y contexto identidad/tenant LOCAL. Restan permisos empresariales y aislamiento de futuros módulos/jobs.
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
