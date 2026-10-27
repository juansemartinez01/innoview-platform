# Operaciones técnicas y diagnóstico — contrato vigente 2.4

## 2.4 — evaluador efectivo y demostración protegida

Base aprobada 9ab0810, ADR-041. Detener API/BFF y escritores para actualizar código/políticas, preservar `.env`, sesiones y volúmenes. No nuevas credenciales/servicios/dependencias. No crear permisos para usuarios habituales ni un administrador empresarial. Entorno local sigue Node 24/PostgreSQL 18/Keycloak existentes.

```powershell
pnpm install --frozen-lockfile
docker compose up -d --wait --wait-timeout 240
pnpm db:run
pnpm db:show
pnpm db:diagnose
pnpm db:generate src/persistence/migrations/SchemaCheck --check
pnpm dev
```

E-1 migra 11→12 mediante ALTER POLICY transaccional sobre 14políticas app, sin reescribir migraciones. UUID contra CASE seguro; no cast de columna UUID a texto. Roles/ACL/defaults/ENABLE/FORCE/RESTRICTIVE se mantienen, sin tocar políticas operativas ni tablas/sesiones. Aplicar coordinadamente con nuevos diagnósticos; una versión vieja de diagnóstico detectaría el contrato SQL nuevo como drift. No arreglarlo deshabilitando RLS ni cambiando privilegios. No revertir en bases habituales; el down existe para el ciclo descartable de pruebas.

### Ruta y contrato HTTP

GET `/authorization/demo/tenants/:tenantId/companies/:unitId`, Bearer access token del issuer Keycloak aprobado. Permission fijo `foundation.probe.read`, scope COMPANY exacto. Un UUID seleccionado en Portal es candidato, nunca prueba de acceso. La API resuelve Identity existente y Membership ACTIVE sin altas implícitas; verifica tenant/grupo, rol/asociaciones/permiso, unidad y ancestros ACTIVE. Solo `{id,name}` sale al cliente, sin tax_id, lista de otros scopes ni datos RBAC. Cache-Control:no-store. No se agrega selector/administración a Control Center ni endpoints para asignar roles.

AuthenticationGuard emite Principal verificado; AuthorizationReads crea contexto privado acotado al callback. BusinessAuthorizationGuard hace can y llama al contrato de proyección Organizations con el **mismo manager RR/read-only**; el controller devuelve exclusivamente ese DTO ya autorizado. No devolver contexto/manager ni hacer la lectura en otra conexión después de ALLOW. Para nuevas rutas, mantener autorización+lectura/efecto en la misma transacción o reevaluar en la transacción que operará. No crear un UoW genérico para extender la demostración.

401 JWT ausente/inválido;403 falta de concesión/scope en contexto válido;404 uniforme para contexto/tenant no disponible, ajeno o malformado;503+Retry-After:1 ante indisponibilidad/contención. Un scope ajeno/no existente en tenant válido devuelve la misma denegación403. El error incluye correlationId igual al X-Correlation-Id validado/generado; eventos estructurados no contienen código de permiso, tokens, SQL ni trazas. UNKNOWN_PERMISSION queda interno; DEPRECATED niega y emite a lo sumo un evento agregado por request. No convertir resultados vacíos normales en incidentes.

Demostración automatizada: usuario A con Membership/Role/Permission/scope válidos → 200 y proyección mínima ; B con Membership pero sin permiso → 403 ; C de otro tenant → 404, igual que tenant desconocido. Pruebas Keycloak/Nest reales verifican JWT inválido 401, estados y deprecación, revocación y bloqueo SQL real 503/Retry-After. `pnpm test` conserva OIDC/login/logout/refresh, aislamiento de secretos API/BFF, selector y Chromium. Todo en bases/usuarios/roles descartables, sin modificar los usuarios de desarrollo. No existe CLI de concesiones públicas ni seed productivo para habilitar el demo.

### Benchmark E-1 y evaluador definitivo

```powershell
docker compose -f compose.test.yaml up -d --wait --wait-timeout 180
pnpm authorization:rls:benchmark
pnpm authorization:benchmark
docker compose -f compose.test.yaml down
```

El primero crea schema 11 poblado con 20.000 identidades/membresías y verifica migración 12, misma visibilidad/denegación, ausencia de columnas UUID::text, contexto vacío/inválido/whitespace, diagnóstico, revert/reapply descartable e índice ix_membership_identity_status sin hints. Artefacto `infra/authorization/rls-benchmark-result.json` con planes antes/después completos. Predicción declarada antes: scan/filter en v11; acceso UUID indexado en v12 bajo carga, sin exigir ese índice para tablas pequeñas.

El segundo conserva 500 tenants / 50.000 asignaciones, distribución/semilla aprobadas y conteos exactos. Agrega métodos definitivos de AuthorizationEvaluator con contextos de AuthorizationReads app-only y Principal verificado criptográficamente contra JWKS descartable (no marcador fabricado ni bypassRLS). Las pruebas HTTP usan Keycloak real. SQL previo de ADR-040 queda como oráculo congelado; se comparan conjuntos completos ordenados, no solo cardinalidad. Se obtienen EXPLAIN de los SQL definitivos, ancestros y RLS anidada, con condiciones/filtros/filas descartadas/estimaciones/loops/buffers/heap fetches y tamaños de índices. can exige evidencia assignment_member_scope bajo la carga grande, sin materializar la Membership entera.

Metodología: primera observación reproducible después de base creada/cargada, VACUUM y planes de referencia; no es frío real y no se vació caché PostgreSQL/OS. Luego 3 warmups y30 repeticiones por método, separando p50/p95 del método (incluye validación runtime del contexto y SQL agrupado) de la transacción completa (resolución Identity/Membership/disponibilidad/GUC y commit). JWT/JWKS se verifican antes de medir; no es latencia HTTP de login. No SLA ni umbral temporal de CI. Variaciones de buffers, muestreo, SO y host compartido impiden comparaciones temporales ingenuas con otra preparación/consulta.

Revocación benchmark: 30nuevas transacciones después de revocar Membership deben negar aun con catalog_version/tenant_revision idénticos; historial se conserva. Se registran p50/p95 de esa denegación y versiones sin cambios. Una transacción ya iniciada puede mantener su snapshot: no confundir eso con caché de decisiones. No Redis/cachés entre requests ni lecturas de evaluación mediante operadores. El benchmark pesado sigue separado de CI ordinaria.

### Límites y deuda hacia 2.5

RLS continúa aislando identidad/tenant; las políticas SQL no implementan RBAC por compañía para todo SELECT arbitrario del rol app. Guards y operaciones transaccionales son obligatorios para cada futura API empresarial. GUC no autentica a quien ya puede ejecutar SQL arbitrario con la misma conexión. Mantener consultas parametrizadas, credenciales separadas y timeouts actuales.

D-5: responsable del módulo Authorization/Platform Core, supervisión Director/Auditor, objetivo incremento 2.5 **antes del cierre de Fase 2**, compatibilidad de huellas históricas antes de cambiar CURRENT_FINGERPRINT_VERSION. Mantener A-2/operador Organizations amplio, reparación auditada de tenant_directory, instalación desde cero y pruebas adversariales integrales en 2.5. N-1 cerrado; N-3 convención CHECK/FK existentes NOT VALID + VALIDATE cuando corresponda, nunca PK/UNIQUE. Advertencia conocida TypeORM/pg preservada. No comenzar 2.5 sin revisión.

### Resultados locales 2.4 (artefactos finales)

E-1: antes Seq Scan, 267 shared hits, 19.999 filas descartadas; después ix_membership_identity_status, 3 shared hits, 1 fila visible idéntica. No hints ni cambio de permisos. La latencia no se usa como criterio de aceptación.

| Tenant / método        | Método p50 / p95 ms | Transacción p50 / p95 ms |
| ---------------------- | ------------------- | ------------------------ |
| large / can            | 4,460 / 5,398       | 11,777 / 14,652          |
| large / permissionsFor | 7,773 / 8,626       | 14,319 / 16,261          |
| large / scopesFor      | 6,681 / 7,510       | 14,393 / 15,805          |
| small / can            | 4,299 / 4,859       | 10,858 / 12,010          |
| small / permissionsFor | 4,601 / 5,755       | 10,955 / 15,867          |
| small / scopesFor      | 4,564 / 5,360       | 11,284 / 13,507          |

Revocación: DENY por contexto no disponible en la siguiente transacción, con versiones RBAC sin cambios; p50 3,862 / p95 5,325 ms. can exacto utiliza assignment_member_scope en ambos tamaños. Planes finales grandes: runtime:can: 91 hits; runtime:permissionsFor: 2059 hits; runtime:scopesFor: 2060 hits.

Pruebas locales: **147 resultados aprobados (100 PostgreSQL + 47 OIDC/HTTP/runtime/Chromium, incluidos agrupadores)**, sin omisiones/cancelaciones. Doce migraciones aplicadas, generate --check sin diferencias, diagnóstico sin hallazgos/divergencias. La advertencia conocida TypeORM/pg de introspección permanece. Verificar GitHub Actions sobre el SHA publicado antes de aceptar; no se declara cerrada Fase 2.

Los apartados siguientes conservan antecedentes históricos; el contrato actual es 2.4/ADR-041.

## Addendum 2.3b.1 — replay, pools y evidencia RBAC

Base aprobada con condiciones: ee6757ee7b22346227f4f053876194342533af6d. No cambian credenciales, ACL, esquemas, índices ni dependencias. Detener escritores operativos, actualizar código y reiniciar sus pools; no borrar volúmenes ni modificar las once migraciones. `pnpm db:run` debe informar que no hay nuevas migraciones. Mantener show/diagnose y la secuencia de validación existente. No avanzar al evaluador/Guards de 2.4.

### D-6 y D-8

AuthorizationService.assign separa tres fases: (1) replay de solo lectura con rol/GUC verificados y transacción corta, (2) referencias ACTIVE mediante contratos propietarios, sin conexión/transacción retenida de Authorization, (3) escritura idempotente definitiva. Esta última intenta INSERT ON CONFLICT con la PK global requestId y vuelve a leer después del commit concurrente. Solo si realmente insertó una operación nueva puede aplicar el resultado o error de las comprobaciones previas. El error se conserva en memoria solo durante esa llamada, sin caché de disponibilidad. Si son inválidas, rollback revierte el registro pendiente antes de bloquear tenant_revision o modificar concesiones.

Replay completado equivalente devuelve el JSON histórico incluso después de revocar Membership, archivar/desactivar unidad, inactivar rol o tenant. Otro tenant/tipo/actor/motivo/argumentos produce REQUEST_ID_CONFLICT permanente. Si una operación concurrente todavía no confirmó, UNIQUE espera con lock_timeout8s; si confirma se devuelve replay, y si revierte la operación nueva debe satisfacer sus propias referencias. Un timeout produce error técnico transitorio, nunca un falso conflicto ni registro parcial. No se guarda ningún marcador de validación en la sesión/JWT.

Los pools de propietarios conservan acquisition timeout finito (5s normal). La saturación de pg-pool puede producir un Error sin SQLSTATE: solo los mensajes fijos conocidos del driver **sin code** se clasifican como POOL_ACQUISITION_TIMEOUT; jamás se registran mensajes driver/SQL ni secretos. Resolver la causa y reintentar con el mismo requestId; no bucles ilimitados. Las pruebas usan pools reales de una conexión, comprueban que la espera sigue pendiente durante SELECT FOR UPDATE NOWAIT de tenant_revision y que no existe una transacción Authorization idle. Después verifican error recuperable, ausencia de operación/eventos y recuperación con replay. No se conceden permisos de lectura privada ajena a Authorization.

D-8 comprueba current_setting(lock_timeout)=8s dentro del trigger de una asignación real, la retiene deliberadamente 1,6 s y revoca la Membership mientras está pendiente. Una segunda solicitud debe esperar/reproducir el resultado original, sin duplicados; al terminar vuelve a 1 s y sin GUC. Las pruebas anteriores de rollback/55P03/pool físico único continúan. La asignación guardada nunca sustituye la evaluación empresarial.

### D-1 / D-2 / D-3: consultas candidatas

Ejecutar `pnpm authorization:benchmark` con compose.test.yaml saludable, como en el apartado siguiente. Solo bases/roles generados descartables; carga fija con semilla innoview-authorization-20261026-v1, 500 tenants / 50.000 asignaciones, mismo sesgo y conteos que 2.3b. La membership grande tiene 420 asignaciones y la pequeña 20. Se ejecuta VACUUM (ANALYZE) por tabla mediante el propietario migrador, **fuera de cualquier BEGIN**, sin desactivar RLS/triggers ni conceder nuevos privilegios. No es una recomendación de ejecutar mantenimiento sobre datos habituales.

`infra/authorization/candidates.mjs` contiene solo SQL de benchmark. Compara variantes NOT MATERIALIZED y MATERIALIZED de validación de tenant/membership, unidades disponibles/ancestros y concesiones rol/permiso/asignación. Cada consulta utiliza una nueva transacción TenantReadTransactions: el prechequeo propietario de disponibilidad se realiza una vez dentro del snapshot actual; los CTE materializados evitan expandir repetidamente sus conjuntos. **Las políticas siguen ejecutando todos sus controles anidados**; prevalidar no omite RLS ni autoriza reutilizar comprobaciones de una transacción anterior. Se filtran estados ACTIVE de tenant, unidad/ancestros, membership, rol, RolePermission, RoleAssignment y Permission, con tenant/membership explícitos. Jerarquía fija, scopes exactos sin herencia.

El artefacto registra EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) completo y resumen de cada nodo: filas estimadas/reales, loops, shared hits/reads, Index Cond, Filter, Rows Removed by Filter/Recheck y Heap Fetches cuando existan. `rlsWork` señala nodos Membership/tenant_directory, incluidos los chequeos explícitos de membership; los contadores de nodos anidados son inclusivos y se superponen. **No sumarlos como costo independiente ni presentar su tiempo como una medida aislada de RLS.** Plan raw permite inspeccionar subplanes, condiciones y estimaciones.

| Consulta / tenant | Inline filas / hits / ms | Materializada filas / hits / ms |
| ----------------- | ------------------------ | ------------------------------- |
| Permisos grande   | 2 / 11.118 / 19,185      | 2 / 4.914 / 14,352              |
| Scopes grande     | 21 / 252.968 / 230,031   | 21 / 4.914 / 11,255             |
| Exacta grande     | 1 (true) / 112 / 0,474   | 1 (true) / 155 / 0,892          |
| Permisos pequeño  | 2 / 10.147 / 10,524      | 2 / 455 / 0,767                 |
| Scopes pequeño    | 5 / 5.526 / 4,887        | 5 / 455 / 0,853                 |
| Exacta pequeño    | 1 (true) / 94 / 0,528    | 1 (true) / 171 / 0,457          |

En scopes grande, la variante inline repite la búsqueda de asignaciones 21 filas × 420 loops; la materializada lee 420 filas × 1 loop y comparte ese conjunto con los joins. Membership/directorio siguen apareciendo en los subplanes RLS y constituyen costo relevante incluso en la variante mejorada. Recomendación para 2.4: partir de conjuntos materializados de asignaciones/concesiones/unidades dentro de la transacción actual para permisos/scopes, y búsqueda puntual con EXISTS para concesión exacta. Validar de nuevo sobre la implementación real y distribuciones mayores; no convertir este SQL en un servicio productivo en 2.3b.1.

D-2: conservar assignment_member_scope. La búsqueda exacta usa Index Only Scan con tenant_id/membership_id/scope_type/scope_unit_id como Index Cond, 1 fila / 1 loop y 0 Heap Fetches tras VACUUM. También se usa para 20 asignaciones de la membership pequeña. Ocupa 7.946.240 bytes en esta carga, además del UNIQUE parcial (7.503.872 bytes) y assignment_tenant (3.260.416 bytes). Tiene costo de mantenimiento por cada escritura activa, pero cubre un acceso medido que el benchmark anterior omitía; no se ha demostrado que quitarlo mejore el balance. No se cambia orden, no se elimina, no se agregan índices alternativos ni migración especulativa. Las 50.000 altas y sus triggers/auditoría continúan ejecutándose bajo roles reales.

Comparación histórica preservada en approvedBaseline: la consulta antigua grande devuelve 400 filas, con 9.261 hits / 7,522 ms antes; después de VACUUM, la misma forma devuelve 400 filas con 5.057 hits / 6,324 ms. VACUUM permite más accesos index-only sin visitas al heap y cambia estadísticas/visibilidad; hay calentamiento de buffers, muestreo y carga del host compartido. Las consultas nuevas además proyectan DISTINCT y validan ancestros: **sus latencias no son directamente comparables con la consulta antigua**, ni hay SLA/umbral temporal CI. Entorno Windows/Docker Desktop, PostgreSQL 18.6, Node 24.22.1; las mediciones definitivas del evaluador quedan en 2.4. Benchmark pesado separado de CI ordinaria.

Riesgos mantenidos: D-4 uuid::text en Organizations y D-5 evolución histórica de huellas Authorization al cierre de Fase 2; D-7 obliga a filtrar rol INACTIVE en 2.4 sin borrar historia; uq_role_tenant_name conserva el nombre reservado incluso INACTIVE. A-2/operador Organizations amplio y reparación soportada de tenant_directory quedan en 2.5, junto a instalación desde cero. TOCTOU entre propietarios, GUC modificables por SQL arbitrario, snapshots ya abiertos y advertencia conocida TypeORM/pg permanecen.

Solo desarrollo local controlado; no es un despliegue productivo ni un instalador general. Modelo RBAC persistente de 2.3b aprobado con condiciones en ee6757e; 2.3b.1 pendiente de revisión, sin evaluador, Guards ni administración empresarial HTTP. Los apartados históricos debajo conservan su contexto; ADR-040 y el addendum superior tienen precedencia para el contrato actual.

## Actualización 2.3b y separación de actores

Detener los tres servidores y todos los escritores operativos. No borrar volúmenes, regenerar credenciales existentes ni ejecutar down de migraciones en una base habitual. Agregar a `.env` únicamente `DB_AUTHORIZATION_USER=innoview_authorization_operator` y una `DB_AUTHORIZATION_PASSWORD` aleatoria nueva, independiente de los otros 15 secretos. Puede generarse sin imprimirla con un script local usando `crypto.randomBytes(32)` y escribir solo la línea faltante. `.env.example` deja el valor vacío. No ejecutar herramientas contra una base elegida por un parámetro HTTP.

```powershell
pnpm install --frozen-lockfile
docker compose up -d --wait --wait-timeout 240
pnpm db:provision
pnpm db:run
pnpm db:provision
pnpm db:show
pnpm db:diagnose
pnpm db:generate src/persistence/migrations/AuthorizationCheck --check
pnpm dev
```

La migración 11 agrega ocho tablas Authorization, funciones SECURITY INVOKER, políticas/grants exactos y un CHECK adicional sobre organizations.operation mediante NOT VALID/VALIDATE. No editar migraciones anteriores. Para tablas pobladas, usar ese patrón solo en CHECK/FK admitidos y con plan de mantenimiento; no aplica a PK/UNIQUE. Las tablas nuevas crean constraints directamente. Mantener escritores detenidos: VALIDATE en la misma transacción no elimina el lock adquirido por ADD CONSTRAINT. Un fallo debe revertir toda la migración, sin marcar historia manualmente; show/diagnose confirman el resultado antes de reiniciar pools. Generate --check no administra automáticamente los triggers/FK del modelo Authorization: sus entidades no sincronizan DDL, cuyo contrato se verifica en PostgreSQL real.

### Matriz de privilegios de Authorization

| Actor                                      | Catálogo global Permission/Version                     | Role/RolePermission/RoleAssignment/Revision                                              | Operation/AuditEvent                                                                         | Otros datos                                                |
| ------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Migrador                                   | Catálogo por migraciones; versión derivada por trigger | DDL, ownership y políticas; FORCE aplica a DML sin política                              | DDL y ownership                                                                              | Esquemas administrados, sin SUPERUSER/BYPASSRLS            |
| Aplicación API                             | SELECT                                                 | SELECT con frontera tenant/identidad/directorio; asignaciones propias vía Membership RLS | Ningún acceso                                                                                | Contratos existentes; sin escrituras Authorization         |
| Operador Authorization                     | SELECT                                                 | SELECT/INSERT tenant-scoped; UPDATE solo columnas operativas, revisión derivada          | SELECT/INSERT; UPDATE solo resultado/completed_at en operación pendiente, auditoría derivada | Sin sesiones ni lectura privada Memberships/Organizations  |
| Operadores Organizations/Memberships y BFF | Ninguno                                                | Ninguno                                                                                  | Ninguno                                                                                      | Solo privilegios de sus módulos existentes                 |
| Bootstrap                                  | Solo aprovisionamiento local controlado                | No se usa en operaciones normales                                                        | No se usa en operaciones normales                                                            | Credencial administrativa separada de los procesos runtime |

Ningún rol runtime obtiene DELETE/TRUNCATE/REFERENCES/DDL/ownership/BYPASSRLS ni privilegios globales nuevos. La función exacta require_operation debe conservar EXECUTE únicamente para el operador Authorization: sus triggers SECURITY INVOKER validan la operación pendiente por UUID. Aprovisionamiento reconcilia esa excepción después de retirar grants viejos; PUBLIC y otros roles no tienen EXECUTE en funciones Authorization. Secuencias nuevas: ninguna, UUID generados por PostgreSQL.

Los launchers API y ambos BFF siguen usando allowlists; `DB_AUTHORIZATION_USER/PASSWORD` quedan fuera del proceso servidor y sus hijos, igual que las demás credenciales privilegiadas. La API falla antes de importar Nest si se inyectan accidentalmente DB_* no admitidas. Las herramientas de mantenimiento pueden leer `.env`; en despliegues futuros deben recibir exclusivamente su propio secreto mediante configuración por proceso. Allowlists no protegen de un administrador del host ni de SQL arbitrario con la misma conexión. No imprimir conexiones, contraseñas, SQL con parámetros, JWT ni errores driver completos.

### Invocación técnica confiable, sin endpoints

`initializeAuthorizationOperatorDataSource(env)` valida que el rol sea el operador independiente y no posea flags/ownership/membresías privilegiadas. Instanciar `AuthorizationService(source, references)` solo en una herramienta técnica confiable. `references` delega `membershipActive` a MembershipsService con su fuente operativa propia y `scopeAvailable` a OrganizationsService con la suya; no pasar su EntityManager al módulo ajeno ni ampliar grants Authorization. Cada fuente debe recibir DB_HOST/PORT/NAME/SSL y su pareja DB_<PROPOSITO>_USER/PASSWORD. Destruir las fuentes al finalizar. No registrar estas conexiones en AppModule HTTP.

Métodos: createRole, setRoleStatus, grantPermission, revokePermission, assign y revokeAssignment. El invocador entrega tenant UUID verificado y TrustedOperation con actor técnico SYSTEM/INNOVIEW_OPERATOR, motivo y requestId UUID estable por operación lógica; no recibe ese contexto de un navegador. El wrapper valida marca de rol, abre transacción, establece GUC LOCAL tenant/actor/motivo/requestId/tipo y lock_timeout8s, inserta operación idempotente, bloquea la revisión del tenant, escribe y completa resultado. Datos/revisión/auditoría son atómicos. No compartir tablas operation/audit_event o credenciales entre módulos. Catálogo se cambia únicamente mediante una nueva migración; no pasa por este servicio.

Reintentar la misma operación/contexto reproduce el resultado original, no una lectura actual. Cambiar argumentos, tipo, tenant o procedencia con el mismo UUID produce REQUEST_ID_CONFLICT. Historial completado y revocaciones son inmutables; reasignar crea nueva fila/requestId de nueva operación lógica. No limpiar filas de operation para reciclar identificadores.

Asignación comprueba Membership ACTIVE y disponibilidad de tenant/unidad/ancestros con contratos de sus propietarios, con snapshots distintos: ventana TOCTOU explícita. Una asignación guardada puede dejar de estar disponible inmediatamente después; no es efectiva sin revalidación transaccional en 2.4. FK comprueba existencia/tipo/tenant, no estado. RLS de autorización limita filas por tenant, no implementa evaluación de permisos empresariales. No lanzar SQL operativo desde API ni dar acceso a usuarios por ser miembros/seleccionar tenant.

### Contención y recuperación N-1

Default de rol Organizations/Authorization: lock_timeout1s; wrapper confiable SET LOCAL8s antes de locks/ON CONFLICT, por debajo de statement_timeout20s. API/BFF siguen 1s. Migrador3s y Memberships1s sin cambios. Idle30s/transaction120s de operadores conservados. El incremento de revisión serializa cambios de autorización de un tenant y puede producir contención; es una decisión deliberada para escrituras poco frecuentes.

55P03, 40001, 40P01, clase08 y errores pertinentes de conexión se clasifican como TrustedOperationTransientError, retryable y retryAfterSeconds1; solo se emite TRUSTED_OPERATION_CONTENTION con requestId. No se imprimen SQL/mensajes driver ni se consulta la transacción abortada. Primero verificar rollback, resolver contención legítima y repetir con el mismo requestId. Nunca reintentar REQUEST_ID_CONFLICT como indisponibilidad. Sin bucles automáticos ilimitados. La futura capa HTTP 2.4 deberá mapear el error a estado/Retry-After apropiados; no existe un endpoint nuevo. La regresión demora el primer request 1,6s y verifica que el segundo obtiene replay, sin datos/eventos duplicados.

### Benchmark RBAC descartable

```powershell
docker compose -f compose.test.yaml up -d --wait --wait-timeout 180
pnpm authorization:benchmark
docker compose -f compose.test.yaml down
```

Requiere TEST_DB_HOST/PORT/POSTGRES_PASSWORD existentes de `.env`, PostgreSQL 18.6 y build API. No necesita Keycloak para generar datos sintéticos; la suite normal sí ejecuta Keycloak/Chromium. Solo crea `innoview_test_<UUID>` y roles nuevos, y limpia exclusivamente lo que creó en finally. No usa DB_NAME habitual, no borra volúmenes y no desactiva triggers. Fuera de CI ordinaria pesada. Semilla `innoview-authorization-20261026-v1`; distribución lógica/UUID de fixtures deterministas, UUID Membership generados por el servicio y fechas/datos operativos de cada ejecución no son bit a bit idénticos.

Volumen: 500 tenants (uno con 25.050 asignaciones y 499 con 50), 50.000 asignaciones, tenant grande con 100 identidades / 20 roles / 10 compañías / 10 sucursales; pequeños con 3 identidades / 4 roles / 2 compañías / 2 sucursales. Dos permisos técnicos por rol, grupos y jerarquía completa. Lotes de 250 asignaciones/transacción y procesos operativos reales con RLS/guardas/auditoría/revisiones activas. Entorno local Windows/PowerShell/Docker Desktop, Node 24.22.1; reporte registra versión PostgreSQL y semilla. Conteos finales exactos, no estimaciones de pg_stat.

Predicción emitida **antes** de ejecutar: acceso B-tree tenant/membership/scope para concesiones, PK para revisión, joins de ancestros de profundidad fija, índice UUID por tenant para operador. EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) bajo rol API contextual incluye permiso/rol vigentes y sobrecosto RLS; el operador se mide aparte. Se permiten planes equivalentes del optimizador, sin hints ni umbrales de tiempo. Índice completo assignment_tenant soporta lectura operativa de historia, además de índices parciales ACTIVE. El artefacto `infra/authorization/benchmark-result.json` conserva nodos/índices/filas/buffers/tiempos locales; no es garantía temporal ni evaluador definitivo de 2.4.

El benchmark anterior de 20.000 operaciones Organizations ahora usa 20 lotes de 1.000, todos con triggers activos y límites ordinarios. Conserva comparación Seq Scan con cast de columna frente a Index Scan operation_pkey UUID, y continúa en CI normal. No confundir el nombre de fixture con una prueba sobre datos de desarrollo.

Pendientes 2.4: evaluación efectiva, Guards, relectura de disponibilidad Membership/Organizations y ancestros, invalidación demostrada antes de cachear, consulta real del evaluador/benchmark. Pendientes 2.5: hardening del operador Organizations de alcance amplio, diagnóstico/reparación soportada de tenant_directory e instalación reproducible desde cero. No declarar cerrada Fase 2.

## Corrección 2.3a.1 — antecedente aprobado

2.3a y esta corrección quedaron aprobados y cerrados en `0d92c34`. ADR-038 agregó la décima migración OperationTriggerHardening1793030400000, sin editar las nueve anteriores. Este antecedente no incorporó variables/dependencias nuevas ni RBAC; 2.3b extiende el contrato según el apartado vigente de arriba.

Detener API/BFF y **todos los escritores operativos** antes de actualizar. Ejecutar la secuencia de actualización del apartado siguiente, que ahora aplica diez migraciones; reiniciar pools tras provisionar. No mezclar código escritor antiguo y esquema nuevo: las filas previas son fingerprint_version=1 y el nuevo default/escritor es 2. El servicio nuevo reproduce v1 y v2 según la versión almacenada, sin recalcular historial. Revert solo para el ciclo de bases descartables; no degradar código/esquema sobre registros v2 persistentes.

### Triggers y procedencia

Los dos triggers de escritura/auditoría leen el GUC, rechazan ausencia o formato no canónico mediante IF y solo después convierten a variable UUID. La búsqueda `request_id=operation_uuid` utiliza la PK UUID, sin convertir la columna a texto. No depender del orden de evaluación de AND/OR para evitar 22P02. El rechazo seguro es 42501. Se mantienen estado pendiente, rol y actor/motivo/tipo. Completar una operación mediante UPDATE exige que OLD/NEW request_id coincidan con el contexto LOCAL; otra operación pendiente no puede completarse accidentalmente.

actor_type ya no tiene DEFAULT histórico para INSERT nuevos. Eventos verificados requieren technical_source no nulo ni vacío; filas LEGACY_UNVERIFIED existentes se conservan sin reatribución. El operador no puede insertar eventos directamente. Auditoría operativa necesita consultar tanto `organizations.operation` como `organizations.audit_event`, ligados por operation_request_id: varias filas por alta, ninguna transición adicional para un no-op y ningún evento nuevo para replay. No asumir UNIQUE(request_id) en auditoría ni usar un replay como lectura actual.

### Huellas y compatibilidad

V1 permanece exactamente como se generó en 2.3a: envelope JSON con version/type/args, orden de claves solo del primer nivel de args y orden histórico de objetos anidados. La nueva columna asigna 1 a registros existentes; no modifica sus hashes, resultados o timestamps. Las pruebas crean operaciones Tenant/Company en esquema v9, aplican v10 y reintentan con el servicio nuevo, comprobando resultado/huella/eventos originales.

V2 ordena recursivamente claves mediante comparación de código, conserva orden de arrays y codifica nodos con etiquetas de tipo. Ausencia de propiedad, propiedad undefined, null y valores ordinarios no colisionan con marcadores del serializador. Formato admitido: objetos planos (también prototipo null), arrays densos sin propiedades extra, strings, booleanos, undefined, null y números finitos, incluido -0 distinguido. No admite getters/setters, ciclos, Date/Map/Set/BigInt/funciones/symbol ni propiedades ocultas. No ejecuta getters o toJSON. UUID y nombres se normalizan antes, en OrganizationsService. No se agrega una librería de canonicalización. La versión forma parte de la huella y del registro; versiones desconocidas no se reinterpretan.

### Política de locks y reintentos

| Rol                           | lock_timeout vigente         | Otros límites                              |
| ----------------------------- | ---------------------------- | ------------------------------------------ |
| API / Portal / Control Center | 1 s                          | 5/10/30 s sin cambios                      |
| Organizations / Memberships   | 1 s                          | 20/30/120 s sin cambios                    |
| Migrador                      | 3 s                          | statement/idle/transaction no se modifican |
| Bootstrap                     | Independiente, no modificado | Sin cambios                                |

SHOW/current_setting en conexiones nuevas confirma los valores. lock_timeout acota **cada espera** de adquisición de lock, mientras statement_timeout acota la sentencia, idle limita inactividad y transaction limita duración total. No limita la duración de DDL después de adquirir el lock ni sustituye mantenimiento. No elevar globalmente límites de API para ejecutar migraciones.

**Encolamiento DDL:** una petición ACCESS EXCLUSIVE pendiente puede encolar lecturas posteriores aunque otra transacción siga leyendo. El timeout del migrador limita la espera, pero durante esa ventana los consumidores pueden alcanzar su propio límite de 1 s. Aplicar migraciones en una ventana, sin tráfico/escritores concurrentes y con transacciones cortas. Para cambios largos, planificar duración/locks/backup antes, no añadir reintentos ciegos que mantengan la cola.

Ante 55P03 del migrador: detener el intento, verificar rollback de la transacción y que no quedó una sesión esperando locks; revisar pg_stat_activity/pg_locks con actor autorizado sin registrar SQL/parámetros sensibles. Resolver o esperar el fin legítimo del bloqueador, sin terminar sesiones ajenas automáticamente. En mantenimiento, ejecutar `pnpm db:show`, confirmar qué migraciones siguen pendientes y repetir `pnpm db:run` con los mismos archivos/credenciales. Verificar nuevamente show/diagnose y esquema. No editar historia ni marcar la migración como aplicada manualmente. La prueba usa una migración técnica exclusiva de fixture: falla con 55P03, no deja tabla/columna/history parcial y se ejecuta/revierte después de liberar el bloqueo.

Una operación estructural cancelada por lock revierte registro/datos/eventos. Al cesar contención, reintentar **el mismo requestId y contexto**; el pool debe haber terminado rollback o descartado una conexión fallida antes de reutilizarla. No consultar la transacción abortada para decidir si existe el resultado. Los tests verifican contexto identity/tenant vacío después de 55P03 y reutilización de la misma conexión para el rol API.

### Reproducir la evidencia del índice

```powershell
docker compose -f compose.test.yaml up -d --wait --wait-timeout 180
pnpm --filter @innoview/api test
docker compose -f compose.test.yaml down
```

El test crea su propio DB_NAME `innoview_test_<UUID>` con roles independientes. Carga 20.000 registros técnicos SYSTEM completos dentro de una fixture, usando rol Organizations y triggers activos, sin empresas/usuarios reales. Ejecuta ANALYZE como migrador y EXPLAIN(FORMAT JSON) como operador, bajo RLS. Entorno: PostgreSQL 18.6-bookworm, Node 24.22.1; ejecución local Windows/Docker Desktop y misma suite en CI Ubuntu. No ejecutar esta carga sobre DB_NAME habitual ni copiar el SQL de fixture a producción.

Plan local observado, para las búsquedas equivalentes a ambos triggers:

| Predicado                     | Ruta observada                                             |
| ----------------------------- | ---------------------------------------------------------- |
| `o.request_id::text=$1::text` | Seq Scan de operation                                      |
| `o.request_id=$1::uuid`       | Index Scan, operation_pkey, Index Cond por request_id UUID |

Se admiten Index Scan/Index Only Scan/Bitmap Index Scan. La aceptación no usa tiempos de reloj ni fuerza parámetros del optimizador. Además del plan, la suite inspecciona pg_proc para comprobar el UUID local/predicado en **ambas funciones** y el orden validación/conversión. La carga añade pocos segundos al caso local y permanece en la suite normal de CI; no requiere comando de benchmark sobre datos persistentes. Los JSON de plan se emiten como evidencia técnica, sin secretos.

Riesgos abiertos: alcance amplio del operador Organizations (revisión en 2.5), reasonCode detallado pendiente, lectura conjunta de registro/eventos, dependencia de representación SQL de políticas, GUC alterables y advertencia conocida TypeORM/pg. Ninguno se declara resuelto por esta corrección.

## Actualizar una base existente

Conservar `.env`, sesiones y volúmenes. Detener los servidores antes de actualizar código y contratos de escritura. No hay variables, credenciales o dependencias nuevas.

```powershell
pnpm install --frozen-lockfile
docker compose up -d --wait --wait-timeout 240
pnpm db:provision
pnpm db:run
pnpm db:provision
pnpm db:show
pnpm db:diagnose
pnpm dev
```

La novena migración OrganizationOperations1793023200000 es aditiva. Mantiene eventos/actores/request_id anteriores; los nuevos campos distinguen explícitamente LEGACY_UNVERIFIED. No inventa identidades ni operaciones históricas. El segundo aprovisionamiento reconcilia ACL exactas del registro nuevo. Los límites ALTER ROLE IN DATABASE afectan conexiones **nuevas**: reiniciar los pools/API/BFF/operadores tras aprovisionar. No se modifica el timeout del migrador ni del bootstrap.

## Escrituras confiables de Organizations

Un operador técnico autorizado por Innoview obtiene `initializeOrganizationsOperatorDataSource` en un proceso independiente y crea OrganizationsService. Nunca inyectar esa credencial en Nest HTTP/BFF ni exponer este contexto en body HTTP. Cada invocación requiere un actor técnico reconocido por ese operador, motivo y UUID estable **por operación lógica**. El contrato pequeño compartido TrustedOperation contiene actor/reason/requestId; OrganizationOperation agrega actorType y prepara userIdentityId para un flujo futuro.

Firmas actuales:

```ts
createTenant(name, groupName, operation);
createCompany(
  tenantId,
  businessGroupId,
  name,
  taxId /* undefined o null explícitos */,
  operation,
);
createBranch(tenantId, companyId, name, operation);
setStatus(tenantId, unitId /* null para Tenant */, status, operation);
getStructure(tenantId, manager /* misma fuente y transacción activa */);
```

actorType admite INNOVIEW_OPERATOR o SYSTEM en 2.3a. USER_IDENTITY tiene representación/FK real a Identity, pero el servicio y el trigger de operaciones lo rechazan hasta que exista autenticación **y autorización** administrativa verificadas. No usar email arbitrario como identidad del actor. host:usuario OS es solo metadato técnico complementario; el control de la credencial/host operativo sigue siendo parte de la confianza, no una prueba criptográfica de quién ejecutó el proceso.

Guardar requestId antes de ejecutar. Ante respuesta incierta o desconexión, reintentar con **el mismo contexto y argumentos**. La PK global de organizations.operation serializa el request; READ COMMITTED + INSERT ON CONFLICT DO NOTHING + lectura siguiente observa el commit concurrente sin operar sobre una transacción abortada. Un lock de Tenant previo al FK evita deadlocks de promoción de KEY SHARE a FOR UPDATE. UUID a minúsculas, nombres trim según el servicio; argumentos con claves ASCII ordenadas, envelope JSON `{version:1,type,args}` y SHA-256. Omisión, null y valor de taxId son distintos explícitamente. Actor/tipo/motivo normalizados también deben coincidir. Cambiar argumentos, operación, tenant o procedencia da OrganizationOperationConflictError, código seguro REQUEST_ID_CONFLICT.

Se devuelve la representación original persistida, incluidas fechas, aunque el estado actual haya cambiado después. No usar un replay como lectura actual ni como autorización. Una operación puede generar varios audit_event; no hay UNIQUE(request_id) en auditoría. Nueva operación SET_STATUS sin cambio registra su resultado, pero no inventa otra transición. Registro, datos, eventos y proyección se confirman o revierten juntos; una constraint diferida impide confirmar registros incompletos. El registro completado y su auditoría no son modificables por el operador. No reutilizar requestId después de fallos lógicos para otra operación.

**Retención:** registros estructurales durables, sin TTL ni limpieza automática. Crecimiento lineal por operación lógica más eventos de sus registros. Índices PK(request_id), operation(tenant_id,created_at) y audit_event(operation_request_id). Los resultados pueden contener nombres y atributos privados de la estructura: acceso solo operador, misma protección de backups que Organizations, nunca respuestas/logs HTTP. Una política futura de archivo necesita conservar unicidad/tombstones de requestId y semántica de replay; no eliminar para permitir reciclaje de IDs. Antes de fijar retención temporal, medir volumen, obligaciones de historial y almacenamiento; sin SLA inventado.

## Timeouts por rol

| Rol                                    | statement_timeout           | idle_in_transaction_session_timeout | transaction_timeout         |
| -------------------------------------- | --------------------------- | ----------------------------------- | --------------------------- |
| API / Portal / Control Center          | 5 s                         | 10 s                                | 30 s                        |
| Organizations / Memberships operadores | 20 s                        | 30 s                                | 120 s                       |
| Migrador / bootstrap                   | Sin modificación automática | Sin modificación automática         | Sin modificación automática |

Valores iniciales para consultas cortas y operaciones estructurales locales, no compromisos de producción. transaction_timeout existe desde PostgreSQL 17; se utiliza PostgreSQL 18. Abarca la transacción completa y termina la sesión, mientras statement_timeout cancela la consulta. Si transaction_timeout es menor o igual a los otros límites, los más largos se ignoran. El valor debe estar establecido antes del BEGIN correspondiente. Defaults verificables con SHOW/current_setting en conexiones nuevas de cada rol. Ver [documentación PostgreSQL 18](https://www.postgresql.org/docs/18/runtime-config-client.html) y [release 17](https://www.postgresql.org/docs/17/release-17.html).

Los tests verifican cancelación real a 5 s y recuperación de la misma conexión TypeORM tras rollback; para los límites que terminan sesiones reducen los valores solo en conexiones de la fixture, verifican SQLSTATE 25P03/25P04 y conexiones nuevas limpias del pool. No probar timeouts o fallos en datos habituales. No hacer HTTP durante transacciones. Ajustar solo tras medir duración/contención, con ADR y regresión; no desactivar límites para el servidor habitual. Son defaults operativos, no barrera contra SQL arbitrario capaz de SET. Tampoco revocación instantánea de un snapshot iniciado.

## Eventos y correlación

Taxonomía: AUTHENTICATION_REJECTED, AUTHORIZATION_REJECTED, SECURITY_CONTEXT_MISSING, DATABASE_PRIVILEGE_REJECTED, DATABASE_UNAVAILABLE, DATABASE_OPERATION_FAILED, TRUSTED_OPERATION_REJECTED, TRUSTED_OPERATION_REPLAY, TRUSTED_OPERATION_CONFLICT.

API acepta X-Correlation-Id únicamente si es UUID canónico en minúsculas; de lo contrario genera otro. Devuelve el valor controlado y lo propaga mediante AsyncLocalStorage, sin convertirlo en identidad o permiso. Eventos técnicos usan requestId validado. Los registros estructurados solo admiten event/correlationId/requestId: no reciben errores, SQL, objetos request, tokens, cookies, passwords, payloads cifrados o identificadores de usuario. No propagar cabeceras arbitrarias a logs.

401 se registra en AuthenticationGuard; 403 explícito en filtro HTTP (actualmente restricciones técnicas, no RBAC empresarial). Errores de persistencia se clasifican por código sin imprimir objetos: 42501 → privilegios; conexión/clase 08/indisponibilidad → DATABASE_UNAVAILABLE; otros fallos → DATABASE_OPERATION_FAILED. Respuestas públicas conservan mensajes seguros. getStructure rechaza manager/contexto ausente antes de leer y registra SECURITY_CONTEXT_MISSING. Una consulta válida con cero filas, incluido filtrado RLS, **no** es automáticamente un rechazo ni un ataque. Una ruta pública sin opciones tampoco es un error de contexto.

## Invariantes y directorio

`pnpm db:diagnose` usa exclusivamente el rol Organizations ya existente. Inventaría tablas/columnas por pg_catalog de los siete esquemas actuales y descubre también esquemas nuevos propiedad del migrador gestionado; comprueba privilegios efectivos por OID (sin USAGE adicional a esquemas privados), políticas pg_policies, ownership/roles/DDL, secuencias, funciones y default ACL. Devuelve nombres de objetos/contratos, no valores privados. Sale 1 ante hallazgos/error y 0 si ambos controles están sanos; no repara nada. No ejecutar como servidor HTTP.

Contratos explícitos sin RLS actual: probe técnico Foundation; metadata privada migrador; Identity append/read; sesiones separadas por rol; auditoría Memberships privada, inmutable y solo operativa. No se permiten excepciones silenciosas: una tabla sin RLS desconocida se informa y ningún objeto nuevo hereda acceso administrativo. Se conservan únicamente defaults aprobados de probe/sesiones y append/read Identity; tablas futuras requieren revisión/clasificación, incluso en esos esquemas. Las cinco tablas privadas Organizations (incluido Tenant.id), Memberships, directorio, auditoría Organizations y operation se controlan según sus contratos RLS/ACL. Nuevas columnas también se inspeccionan.

Las expresiones SELECT y RESTRICTIVE de la frontera API se contrastan exactamente (normalizando solo whitespace) con el contrato PostgreSQL 18 aprobado. Cambios de representación tras una actualización requieren revisión explícita, nunca actualización automática del esperado. El directorio debe conservar Membership ACTIVE y contexto de identidad. No se modifican las políticas para facilitar el diagnóstico. La suite introduce y restaura grants indebidos por columna/BFF, tabla nueva, FORCE desactivado y deriva de política en su base descartable para demostrar detección.

El segundo control usa un snapshot read-only del operador y compara fuente Tenant/BusinessGroup/OU GROUP con tenant_directory mediante FULL OUTER JOIN. Detecta ausencias, entradas inesperadas, UUID de grupo, nombres y disponibilidad distintos; no confunde visibilidad RLS parcial de API con salud del directorio. CLI solo informa cantidad/tipos de divergencias; el contrato interno devuelve UUID al operador para investigar. Nunca exponerlo por HTTP. La prueba de fallo altera exclusivamente una fixture generada, restaura triggers/políticas/datos y verifica que el diagnóstico no haya reparado la divergencia por sí mismo.

## Incidente de divergencia — emergencia manual

No hay reparación soportada en 2.3a; se programa para 2.5. Ante un hallazgo:

1. Abrir incidente, conservar salida/fecha/commit del diagnóstico y asignar actor administrativo autorizado. No considerar la proyección como fuente de verdad.
2. Evaluar impacto y detener tráfico y escritores en una ventana de mantenimiento; conservar evidencia del estado previo.
3. Realizar backup coherente de fuente, proyección, auditoría y operaciones. Verificar una restauración descartable y su integridad antes de modificar el original.
4. Comparar con fuentes bajo snapshot consistente; identificar causa y conjunto exacto de filas/columnas. Si la fuente no es consistente, detener la recuperación y revisar integridad; no copiar datos dudosos al directorio.
5. Preparar y revisar un script específico del incidente: transacción única, locks y controles de fila antes/después, rollback ante diferencias, límites administrativos deliberados y registro de actor/razón/cambios. La autorización para este mantenimiento no proviene de una sesión API. Los triggers actuales bloquean edición directa: cualquier excepción temporal de política/trigger exige revisión expresa, alcance solo de la proyección y restauración en la misma transacción. **No** desactivar triggers globalmente, quitar FORCE o usar BYPASSRLS como solución rutinaria. No se entrega aquí una orden genérica para saltar controles en producción.
6. Ensayar el script y su rollback sobre el backup restaurado. Registrar SQL revisado/huellas, resultados y aprobaciones; respaldar los valores anteriores. Ejecutar solo la intervención aprobada durante la ventana, nunca desde HTTP.
7. Verificar nuevamente fuentes/FK/constraints, catálogo RLS/ACL y diagnóstico, tanto con operador como con roles efectivos API/BFF en el ensayo. Comparar cambios con el plan y conservar registro del incidente; no reescribir eventos históricos para simular que existió un flujo normal.
8. Reabrir tráfico solo con diferencias cero y controles restaurados. Investigar causa y agregar regresión. Si no puede demostrarse la corrección, rollback/restauración verificada y mantener la ventana; diseñar una migración correctiva específica antes de continuar.

No ejecutar este procedimiento ni fallos inducidos automáticamente sobre volúmenes de desarrollo reales. Una falla de integridad descubierta no se posterga a 2.5; requiere corrección explícita inmediata y revisión.
