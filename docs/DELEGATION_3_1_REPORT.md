# Informe verificable — incremento 3.1

Base aprobada: `753def7f665ca979af21a799ad72d52fde7c1ad9`. Alcance exclusivo: primera asignación delegada de un rol existente. Pendiente de revisión de Dirección/Auditor; no autoriza 3.2 ni invitaciones.

Este informe registra pruebas locales sobre el árbol de trabajo antes de publicar. No atribuye sus mediciones a un SHA futuro. El SHA publicado y la ejecución real de Actions se verifican después del commit y se informan en la entrega. La matriz ejecutada en CI comprueba que GITHUB_SHA coincide con el checkout y registra SHA/run reales en el resumen de Actions.

## Resultado funcional

POST `/admin/role-assignments`, JWT Keycloak real y X-Tenant-Id candidato. Actor obtenido exclusivamente del Principal verificado y de Identity/Membership propias. Retorna solo id/status de asignación; no-store/correlación. A puede asignar a B un rol ordinario contenido en el scope exacto; B no puede delegar. No composición ni revocación HTTP, UI administrativa o concesiones implícitas.

Migración 15 `DelegatedAssignments1793142000000`: ninguna tabla nueva, procedencia humana durable, FK triple coherente, CHECK/FK validados, catálogo técnico reservado y políticas delegadas restrictivas. BEFORE INSERT y constraint trigger diferido invocantes. [Contrato, SQL propietario, privilegios y bootstrap](DELEGATION_3_1.md), ADR-043.

La credencial delegada es independiente y solo llega al pool específico de API. INSERT limitado por columna: cinco referencias de RoleAssignment; envelope/contexto del ledger; columnas de auditoría derivadas. Sin posibilidad de suministrar id/fecha/status de una asignación, UPDATE de asignaciones, composición/catálogo/sesiones/repair, DDL, ownership, herencia, SUPERUSER o BYPASSRLS. App conserva su conexión restringida; BFF conserva aislamiento.

## Evidencia local

| Control                                                         | Resultado                                                                                                                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pnpm install --frozen-lockfile                                  | Correcto; sin dependencias nuevas ni cambios de lockfile                                                                                                               |
| pnpm lint / format:check / typecheck / build                    | Correctos; tres aplicaciones y paquete BFF                                                                                                                             |
| pnpm security:matrix 3.1                                        | **193 resultados, cero fallos**: 134 PostgreSQL + 59 entorno/OIDC/runtime/Chromium/recuperación, incluidos agrupadores                                                 |
| PostgreSQL 18 y Keycloak descartables                           | Casos funcionales, adversariales, concurrencia, JWT reales y sesiones conservados                                                                                      |
| pnpm foundation:verify-clean                                    | Correcto en árbol temporal sin .env/node_modules/.git heredados, bases vacías e IdP separado; incluye suites reales, backup/restore y cleanup del proyecto descartable |
| Actualización de base existente                                 | Backup externo previo; provision→migración15→provision. Sin fixtures administrativos ni borrado de datos/volúmenes                                                     |
| pnpm db:diagnose                                                | Inventario real clasificado; findings=[] y directoryDifferences=0                                                                                                      |
| pnpm db:generate src/persistence/migrations/SchemaCheck --check | Sin diferencias; sin generar archivos                                                                                                                                  |
| Restauración real                                               | Roles remapeados, ACL reconciliadas antes de leer; actor humano/FK/historia/auditoría y lectura HTTP protegida preservados                                             |
| Secretos                                                        | Comparación de archivos versionables contra 19 valores secretos locales: cero coincidencias. Revisión final adicional antes del commit                                 |

Artefacto de matriz: `infra/authorization/evidence/adversarial-3.1.json`. Identifica base y medición de árbol de trabajo; la fuente de verificación del commit publicado es Actions, no esa etiqueta local.

## Escenarios exigidos

| Caso | Prueba/evidencia                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | A→B, Company X, contención; PostgreSQL y HTTP/JWT real permitidos                                                                     |
| 2    | B→C sin facultad, PostgreSQL/HTTP 403                                                                                                 |
| 3    | Permiso adicional no poseído y autoelevación rechazados                                                                               |
| 4    | Company Y no hereda Company X                                                                                                         |
| 5    | COMPANY no hereda BRANCH                                                                                                              |
| 6    | DML sobre rol compartido/composición rechazado por ACL                                                                                |
| 7    | Revocador técnico real espera revisión (pg_blocking_pids); tras confirmar, nuevas solicitudes denegadas                               |
| 8    | Dos administradores y escritor técnico concurrentes; revisión suma exactamente tres cambios                                           |
| 9    | Seis primeras ejecuciones concurrentes del mismo request: un resultado/auditoría/incremento; replay HTTP idéntico                     |
| 10   | Tenant y Membership extranjeros rechazados; SQL fijo en A no lee B                                                                    |
| 11   | JWT real válido sin facultad: 403, sin información empresarial                                                                        |
| 12   | SQL Role/RP, asignación sin pending, actor Membership distinta y lecturas/escrituras ajenas rechazados                                |
| 13   | GROUP no hereda COMPANY                                                                                                               |
| 14   | Membership actor revocada y confirmada durante la operación: revalidación diferida aborta todo, sin ledger/auditoría/revisión parcial |
| 15   | Permission administrativo DEPRECATED no es autoridad; partición terminal descartable                                                  |
| 16   | RequestId incompatible: 409; nunca nueva ejecución                                                                                    |
| 17   | PostgreSQL rechaza bootstrap delegado y USER_IDENTITY técnico; CLI técnica explícita y replay válidos                                 |

Complementos: FK humana inconsistente, clones de Principal/body actor rechazados, Membership destino revocada, roles solapados y autoridad combinada entre roles, namespace reservado incluso histórico REVOKED, cambio concurrente de Role, unidad desactivada antes del commit diferido, reintento tras pérdida de autoridad, contextos NULL/ausentes, pools LOCAL, drift de ACL/policies/trigger, regresión de Organizations/Memberships/selector/Control Center y aislamiento de secretos. Un duplicado ACTIVE con request nuevo produce conflicto seguro, sin convertir una validación normal en 500.

G-1 usa repair real y UPDATE directo: se demuestra lock de fila anterior a BEFORE ROW mediante NOWAIT, timeout 55P03 y rollback sin ledger/fuentes/directorio parciales. No se sustituyen triggers por BEFORE STATEMENT.

## Benchmark de contención

`pnpm authorization:benchmark:delegation` reutiliza semilla innoview-authorization-20261026-v1: 500 tenants, 50.000 asignaciones base, un bootstrap de control adicional, tenant grande con 25.050 asignaciones y roles ordinarios de 40 permisos.

Predicción declarada antes de ejecutar: lookup exacto tenant/membership/type/unit por assignment_member_scope; contención por conjunto sin scan global de asignaciones. EXPLAIN ANALYZE BUFFERS del cuerpo definitivo expandido, bajo rol delegado y RLS reales, utilizó ese índice. Observación local: **9,602 ms de ejecución, 2,512 ms de planificación**. Es una observación con buffers calientes tras carga/VACUUM/planes de referencia, host compartido; no p50/p95, frío OS ni SLA productivo. No se fuerza optimizador ni se ejecuta esta carga pesada en CI ordinaria.

SQL, plan JSON, Index Cond/Filter/Rows Removed/loops/buffers/Heap Fetches: `infra/authorization/delegation-benchmark-result.json`. La contención SQL no cambió durante las correcciones posteriores de ACL/errores/tests; el artefacto conserva su etiqueta de medición local, sin atribución al SHA publicado.

## Problemas resueltos y límites

- FK inmediata del ledger retenía KEY SHARE sobre Tenant e impedía la concurrencia real con Organizations. Se hizo diferible, inmediata por defecto; solo delegado la difiere, conservando validación al commit.
- Adelantar revisión podía ocultar un conflicto histórico global antes de inicializar una revisión nueva. Solo el técnico puede consultar el request completado contextual para detectar ese conflicto; no se amplían app/delegado ni escrituras.
- TypeORM intenta cargar todos los exports de un archivo de migración como clases. El helper de provisioning se separó y la migración conserva su SQL/ACL congelados. Se tiparon explícitamente parámetros UUID/texto y resultados SQL.
- Se verificó restauración después de reconciliar ACL, como exige --no-acl. No se concedieron accesos de datos al mantenedor para hacer funcionar el diagnóstico: usa pg_catalog.
- Validación watch sin compilaciones simultáneas sobre sus fuentes; pruebas finales completas correctas.

H-2 sigue siendo bloqueante para composición delegada futura. GUC no autentica criptográficamente al actor si se roba la credencial; READ COMMITTED/revalidación tiene ventana posterior a su última lectura y requiere evaluación efectiva en operaciones siguientes. Historial idempotente sin TTL/borrado; archivos futuros requieren integridad y preservación de unicidad global. G-4/G-5/G-9 quedan para 3.2 y G-3/G-6/G-8 informativos. Continúa el aviso TypeORM/pg de introspección ya conocido; sin cambio de dependencias para ocultarlo. No se implementaron capacidades de 3.2/3.3 ni producción.

## Archivos del incremento

- `.env.example`
- `.github/workflows/ci.yml`
- `README.md`
- `apps/api/src/authorization/authorization.module.ts`
- `apps/api/src/authorization/authorization.service.ts`
- `apps/api/src/authorization/authorization.spec.ts`
- `apps/api/src/authorization/bootstrap.cli.ts`
- `apps/api/src/authorization/delegation.spec.ts`
- `apps/api/src/authorization/delegation.ts`
- `apps/api/src/authorization/entities.ts`
- `apps/api/src/memberships/membership-rls.spec.ts`
- `apps/api/src/memberships/membership.entity.ts`
- `apps/api/src/memberships/memberships.service.ts`
- `apps/api/src/operations/operation-context.ts`
- `apps/api/src/organizations/organizations.service.ts`
- `apps/api/src/persistence/connection.config.ts`
- `apps/api/src/persistence/data-sources.ts`
- `apps/api/src/persistence/delegation-grants.ts`
- `apps/api/src/persistence/migrations/1793142000000-DelegatedAssignments.ts`
- `apps/api/src/persistence/persistence.spec.ts`
- `apps/api/src/persistence/provision.ts`
- `apps/api/src/persistence/security-diagnostics.ts`
- `apps/api/src/runtime-environment.policy.json`
- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/DECISIONS.md`
- `docs/DELEGATION_3_1.md`
- `docs/DELEGATION_3_1_REPORT.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/OPERATIONS_RUNBOOK.md`
- `docs/PHASE_2_REPORT.md`
- `docs/SECURITY_AND_RECOVERY.md`
- `infra/authorization/adversarial-matrix.mjs`
- `infra/authorization/benchmark.mjs`
- `infra/authorization/delegation-benchmark-result.json`
- `infra/authorization/delegation-benchmark.mjs`
- `infra/authorization/delegation-http.checks.mjs`
- `infra/authorization/disposable.mjs`
- `infra/authorization/evidence/adversarial-3.1.json`
- `infra/authorization/http.checks.mjs`
- `infra/identity/runtime.test.mjs`
- `infra/operations/environment.mjs`
- `infra/operations/recovery.test.mjs`
- `infra/operations/runtime.mjs`
- `package.json`
