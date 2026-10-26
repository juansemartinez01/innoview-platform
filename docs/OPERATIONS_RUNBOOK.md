# Operaciones técnicas y diagnóstico — 2.3a

Solo desarrollo local controlado; no es un despliegue productivo ni un instalador general. 2.2 aprobado en 9175804; 2.3a pendiente de revisión. Sin RBAC ni administración empresarial HTTP.

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
