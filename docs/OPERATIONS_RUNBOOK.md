# Operaciones técnicas y diagnóstico — 2.3a

Solo desarrollo local controlado; no es un despliegue productivo ni un instalador general. 2.2 aprobado en 9175804; 2.3a pendiente de revisión. Sin RBAC ni administración empresarial HTTP.

## Corrección 2.3a.1 — contrato vigente

2.3a aprobado con condiciones en 685a29c; esta corrección queda pendiente de revisión. ADR-038 agrega la décima migración OperationTriggerHardening1793030400000, sin editar las nueve anteriores. No hay variables/dependencias nuevas ni RBAC. Los apartados de 2.3a debajo conservan su descripción histórica, actualizada por este addendum.

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
