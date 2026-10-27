# Incremento 2.5 — informe técnico para revisión

Base aprobada: `07f6b59258306bf67074b402cd71145707c83283`. Fase 2 **pendiente de cierre por Director técnico/Auditor**. No se inicia Fase 3/4.

## Resultado por etapa

| Etapa           | Resultado verificable                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline        | 147 resultados aprobados antes de controles; tres sondas reproducen Principal literal admitido, lectura Organizations fuera del GUC y TypeError como503. Artefactos before conservados.                                 |
| F-1             | Procedencia obligatoria en IdentityReadTransactions antes de conexión; Principal inmutable emitido por verificador; clones/literales y JWT issuer/audience incorrectos rechazados.                                      |
| D-5             | Dispatcher desde fingerprint_version persistido; envelope/serializador v2 congelados. Replay real concurrente conserva hash/resultado/eventos/revisión. No Auth v1 inventada ni cambio de CURRENT_FINGERPRINT_VERSION.  |
| A-2             | Operador Organizations con fronteras tenant RESTRICTIVE; capacidad pretenant separada, CREATE_TENANT atómico/reproducible; lectura SQL/joins sin filtros y escrituras extranjeras rechazadas.                           |
| Recuperación    | Mantenedor aislado, backup custom+manifiesto verificado, gate antes de locks/lecturas fuente, ledger/eventos propios, idempotencia y rollback. Prueba concurrente observa espera real y compara después del commit.     |
| F-2/F-3/F-4/F-8 | Telemetría deprecada contextual; Guard Company limitado a handler concreto; catálogo deprecado solo en partición terminal descartable; 500 interno sin Retry-After frente a503 transitorio, correlación y logs seguros. |
| F-5/F-7         | GUC UUID canónico probado, contexto/mismo pool/snapshots conservados; listados agrupados y can puntual sin cache global ni eliminación de sus comprobaciones runtime.                                                   |
| F-6             | 500 tenants/50.000 asignaciones/2.016 roles; 2 contra 40 permisos/rol, RolePermission 4.032→80.640. Métodos definitivos y conjuntos completos equivalentes al oráculo, p50/p95 y EXPLAIN registrados.                   |
| Instalación     | Árbol temporal sin .env, frozen install, dos PG18 separados y Keycloak, build/API/BFF/Chromium/OIDC/contexto/RBAC/restore; cleanup solo del proyecto generado. Job CI independiente.                                    |

## Persistencia, RLS y privilegios

Migraciones nuevas13/14: OrganizationOperationalBoundaries1793131200000 y DirectoryRepair1793134800000. Las migraciones1–12 no se modifican. Nuevas tablas únicamente organizations.directory_repair_operation/event: FK compuesta entre evento/operación, completitud diferida, RLS ENABLE/FORCE, contexto tenant y registros completados inmutables.

Organizations ordinario no crea Tenant y se limita al tenant LOCAL en las ocho tablas anteriores. Pretenant no puede crear Company/Branch o cambiar estados. Mantenimiento no escribe fuentes ni lee Company/Branch: modifica solo la proyección bajo ledger y sus registros técnicos. App/BFF no adquieren acceso a operadores, ledgers o catálogo de escritura. Bootstrap y migrador siguen separados. Matriz completa y límites de confianza: SECURITY_AND_RECOVERY.md/ADR-042.

El gate transaccional se adquiere en wrapper y trigger anterior a los demás, antes de locks de fila. Repair READ COMMITTED compara después de esperar; evita snapshot previo a la espera e inversión de locks. Cada nueva solicitud empresarial sigue necesitando evaluación dentro de su transacción; FK y RLS tenant no son RBAC por compañía para SQL arbitrario.

## Verificaciones ejecutadas

- Instalación congelada, lint sin advertencias, typecheck y build completo del monorepo satisfactorios. Formato se verifica también después de actualizar evidencia/documentación.
- **163 resultados aprobados:109 PostgreSQL y54 entorno/OIDC/runtime/HTTP/Chromium/recuperación**, incluidos agrupadores; sin fallos, omisiones o cancelaciones. Matriz after conserva todos los casos iniciales y añade controles correctivos.
- Tres sondas after pasan, distinguiendo servicio confiable, PostgreSQL RLS y contrato de error HTTP.
- PostgreSQL18 con roles efectivos: contextos ausentes/invalidos/ajenos, grants/policies indebidos, empresas/sucursales/alcances exactos, estados/revocaciones, SQL/joins sin filtros, pool físico y snapshots. También se prueba que SQL operativo con FK válida puede almacenar una asignación no efectiva contra Membership revocada: el servicio la rechaza y evaluador/RLS no conceden acceso.
- Backup mediante pg_dump y restauración con pg_restore a base diferente: datos sintéticos, policies remapeadas a roles nuevos, metadata física TypeORM ajustada y ACL reconciliadas. FK/constraints/triggers/historial/replay/diagnóstico/schema diff verificados; API restaurada devuelve200 autorizado,401 sin JWT y404 candidato ajeno. Sin restores sobre bases habituales.
- Reparación CLI real: faltantes y valores incorrectos, backup corrupto rechazado, replay/conflicto, historial, fallo con rollback y contención. FK impide sobrante intencional; no se desactiva integridad para simularlo.
- Instalación limpia local satisfactoria desde árbol sin .env, compilación y mismos163 resultados. CI ejecuta este procedimiento sobre checkout nuevo además del job de calidad.
- Entorno habitual actualizado12→14 después de backup local real, sin seeds, borrados o pérdida de sesiones/volúmenes. `db:show`:14 aplicadas; `db:diagnose`:26 objetos descubiertos, findings=[], directoryDifferences=0. `generate --check`:sin diferencias. El backup previo se conserva fuera del repositorio.

GitHub Actions debe verificarse sobre el SHA exacto publicado; el enlace, resultado y SHA se entregan junto con este informe. Los artefactos locales registran la base y que fueron medidos antes de publicar; no atribuyen las pruebas nuevas al código antiguo.

## Rendimiento y limitaciones

Artefactos: infra/authorization/benchmark-result.json, benchmark-wide-result.json, benchmark-width-comparison.json y rls-benchmark-result.json. Comandos y metodología en el runbook. No benchmark pesado en CI ni umbrales temporales arbitrarios.

En tenant grande: can p50/p95 4,029/4,389→4,574/5,115 ms; permissionsFor 7,606/8,630→37,863/39,605 ms; scopesFor 6,214/6,691→7,345/8,027 ms. RolePermission crece20 x por construcción; can puntual conserva1 fila×1 loop e índice assignment_member_scope,91→92 hits. Listados leen2→40 permisos×20 roles,40→800 grants,420 asignaciones; hits2059→4366, sin spill temporal reportado. Planificador cambia estrategia para unidades. Crecimiento observado no equivale a ley asintótica; contexto/RLS y distribución influyen. Sin cambios especulativos de índices ni promesas productivas.

Se conserva evidencia E-1:20.000 membresías, schema 11→12, mismas filas y posterior upgrade 14; índice ix_membership_identity_status utilizado sin forzar planificador. Predicados UUID siguen fail-closed.

## Archivos y operaciones

- Authentication/Identity/Context: procedencia profunda y fixtures firmadas, sin nuevos contratos HTTP.
- Authorization: dispatcher histórico, consulta/telemetría contextual, Guard especializado y pruebas diferenciales/regresión. Puerto authorization.access@1 sin cambio de firmas.
- Organizations/Persistence: dos migraciones, roles/ACL/DataSources, repair/CLI, gates, diagnóstico y pruebas de integridad/operadores.
- Infra: launchers técnicos y allowlists, backup/restore, instalación limpia/Compose, matriz/evidencia, benchmark ancho y partición terminal OIDC/HTTP.
- Documentación/configuración: README, ARCHITECTURE, DATA_MODEL, DECISIONS(ADR-042/addendum041), IMPLEMENTATION_PLAN, OPERATIONS_RUNBOOK, SECURITY_AND_RECOVERY, .env.example, .gitignore, scripts y CI.

No dependencias nuevas. Se mantienen Node 24.22.1, pnpm 11.25.0, PostgreSQL 18.6-bookworm y Keycloak 26.8.1, además del stack aprobado. Secretos nuevos solo en configuración local ignorada; se escanea el contenido candidato al commit contra los valores locales sin imprimirlos. Dumps/manifiestos quedan ignorados.

## Riesgos residuales y aceptación

RLS no autentica al atacante con SQL arbitrario/GUC o control del host/credenciales. RR conserva snapshots iniciados; TOCTOU técnico entre preparación de módulos sigue requiriendo revalidación efectiva. Locks/historial requieren observación y retención; backups necesitan origen confiable, ACL y claves/IdP separados. Futuros archivos, jobs, módulos y producción requieren controles propios. Advertencia conocida TypeORM/pg de introspección permanece visible; no se ocultó.

D-5/A-2 y recuperación/instalación limpia quedan implementados y probados. N-1 sigue cerrado; N-3 sigue vigente. La Fase 2 es técnicamente candidata a cierre tras revisión, **no declarada oficialmente cerrada por esta entrega**. No avanzar a administración delegada sin autorización.
