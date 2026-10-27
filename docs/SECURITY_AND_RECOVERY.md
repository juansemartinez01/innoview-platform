# Seguridad operativa y recuperación — 2.5

## Addendum vigente 3.1 / ADR-043

Fase 2 aprobada; la API incorpora un pool authorization_delegation independiente de app y de operadores técnicos. Solo INSERT de asignación, pending/finalización de ledger, auditoría y revisión derivadas; sin UPDATE delegado de asignaciones ni composición/catálogo/sesiones/repair. Lecturas propietarias con columnas mínimas y RLS específicas. BFF/Portal/Control Center excluyen la nueva pareja. Launchers no son sandbox OS; aislar físicamente secretos/procesos en futuros despliegues.

La auditoría une actor humano y Membership por FK compuesta. GUC no autentica al actor ante SQL arbitrario con la credencial. Contención al INSERT/commit no garantiza composición eterna de roles compartidos (H-2 bloqueante futuro). Retención sin borrado que permita reutilizar requestId. Backup/restore debe conservar procedencia humana y remapear todas las policies a los nuevos roles independientes. [Contrato y matriz de riesgos 3.1](DELEGATION_3_1.md).

Contrato vigente: ADR-042 y OPERATIONS_RUNBOOK.md. Solo desarrollo y ensayos descartables; no instalación productiva ni recuperación PITR.

## Actores y credenciales

| Actor                     | Acceso efectivo                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap                 | Aprovisionamiento/backup local controlado. Credencial administrativa nunca en HTTP/BFF.                                                                                                     |
| Migrador                  | DDL de esquemas gestionados, catálogo Permission y migraciones; sin SUPERUSER/BYPASSRLS/ownership de base.                                                                                  |
| App                       | Identidad append/read, Membership propia, Organizations/RBAC contextual de lectura; sin DML operativo ni lectura de ledgers.                                                                |
| Portal / Control          | Sus sesiones y claves independientes; sin datos/operadores Core.                                                                                                                            |
| Membership                | Bootstrap y revocación propios/auditados; sin privilegios empresariales implícitos.                                                                                                         |
| Organizations             | SELECT/INSERT y columnas de UPDATE exactas dentro de tenant LOCAL. Sin INSERT Tenant, DELETE, DDL o permisos ajenos.                                                                        |
| Organizations provisioner | CREATE_TENANT pendiente, Tenant+GROUP+directorio/auditoría atómicos. Sin Company/Branch/estados. UPDATE(id) Tenant exclusivamente para locks; trigger rechaza UPDATE de datos.              |
| Authorization             | Tablas propias bajo tenant LOCAL; sin editar catálogo ni leer tablas privadas ajenas.                                                                                                       |
| Directory maintenance     | Lectura diagnóstica explícita de Tenant/OU/BusinessGroup, directorio e historial técnico Organizations; no Company/Branch. Escritura solo directorio y ledger/eventos de repair protegidos. |

Los roles runtime son independientes, NOINHERIT, sin SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/DDL/ownership/TEMP ni membresías de roles. Aprovisionamiento reconcilia ACL por tabla/columna y no concede defaults a nuevos objetos. Diagnóstico descubre inventario, policies, funciones/secuencias y grants, y detecta objetos/permisos no clasificados.

API y BFF continúan con allowlists anteriores. Los launchers técnicos crean otro proceso sin shell ni opciones Node heredadas: pretenant recibe solo DB_ORGANIZATIONS_PROVISIONER__, repair solo DB_DIRECTORY_MAINTENANCE__, backup solo DB_BOOTSTRAP_USER/PLATFORM_POSTGRES_PASSWORD, además de conexión común y OS mínimo. El acceso Docker en Windows necesita variables OS públicas ProgramFiles/ProgramData; no credenciales IdP. Leer `.env` en el padre confiable no lo entrega al hijo. No es sandbox: el mismo usuario OS podría leer archivos/montajes; un despliegue futuro deberá separarlos físicamente.

## Qué garantiza cada capa

- PostgreSQL: FK, estados/inmutabilidad, ACL y RLS por identidad/tenant, incluso omitiendo WHERE. Restrictive mantiene la frontera ante otra política permisiva.
- Servicio confiable: Principal original, referencias y disponibilidad al crear operaciones, normalización y actor/motivo/requestId. Los UUID del frontend son candidatos.
- Evaluador: concesión efectiva, scope exacto, membresía/organización/unidad/ancestros y estados RBAC. Membership activa, un row assignment o un tenant seleccionado nunca equivalen a ALLOW.

Un escritor SQL operativo puede satisfacer FK y guardar una asignación cuya Membership después esté revocada; eso no la hace efectiva. FK comprueba integridad global, no disponibilidad o autorización. RLS tenant tampoco restringe automáticamente compañías hermanas dentro del mismo tenant: cada operación empresarial necesita evaluador y lectura/efecto en el mismo snapshot. El Guard demo no es universal.

El proceso que controla una conexión puede modificar GUC; RLS no lo autentica ni detiene SQL arbitrario con esa capacidad. No resiste al dueño DDL, host privilegiado o robo de secretos. Backend confiable fija exclusivamente LOCAL con UUID canónico en minúsculas; SQL con mayúsculas, espacios, llaves o formato inválido falla cerrado. Las rutas que normalizan UUID lo hacen antes de entrar a la transacción. Commit/rollback retiran LOCAL; no SET SESSION confiable ni contextos/managers compartidos.

RR conserva snapshot de transacciones iniciadas. Nuevas transacciones observan revocaciones confirmadas, incluso sin cambiar revisiones RBAC. No cache de decisiones entre requests. Colecciones usan permissionsFor/scopesFor agrupados, no can por fila; can conserva validación de manager/GUC.

## Backup, reparación y restore

Backup usa pg_dump custom sin ownership/ACL ni contraseñas de roles, con SHA-256 y manifiesto de origen. El hash detecta corrupción, **no autentica al autor**: solo restaurar backups confiables. Archivos contienen datos, sesiones cifradas y auditoría; conservarlos fuera del repositorio con ACL privadas y política de retención revisada. No hay cifrado adicional automático ni copia cloud.

La prueba restaura con pg_restore en otra base generada, nunca `--clean` sobre una existente. Aprovisiona roles nuevos, restaura objetos bajo migrador, remapea policies a roles nuevos, reconcilia ACL y ajusta el nombre físico en metadata TypeORM. Conserva actor/resultado/historia, valida constraints/migraciones/schema diff/diagnóstico y prueba lectura HTTP autorizada. Los secretos de roles y claves BFF se gestionan separadamente: pg_dump no respalda roles globales, Keycloak ni claves externas. No prometer recuperación de sesiones/SSO tras pérdida de esas claves o del IdP.

Repair exige backup real verificable y confirmación explícita. G-1: gate por tenant antes de locks de fila en el wrapper; BEFORE ROW no garantiza ese orden para UPDATE directo (el lock de fila puede preceder al trigger); READ COMMITTED compara después de adquirirlo. No desactiva RLS/triggers/constraints. Pending ledger, proyección y auditoría son atómicos. Error implica rollback; un repair confirmado solo admite compensación autorizada con nuevo request/backup y auditoría, nunca borrar eventos ni restaurar una proyección contradictoria con su fuente. Corregir primero la fuente mediante su contrato si estaba equivocada.

La comparación FULL OUTER JOIN detecta sobrantes. Con FK/completitud actuales no se puede fabricar uno legítimamente: la suite verifica restricciones y no las desactiva para inventar cobertura. La inyección de faltantes/valores incorrectos usa la credencial de mantenimiento en una base descartable y registra sus cambios como fixture, sin tocar datos habituales.

## Riesgos que no desaparecen

SQL/host confiables, límites de snapshot, TOCTOU de preparación técnica entre propietarios, colisiones de locks asesores, crecimiento del historial, latencia/contención por tenant y representación SQL de políticas requieren seguimiento. Archivos, jobs, eventos y módulos futuros necesitan controles propios. No hay administración delegada, SUBTREE, permisos globales, caché global o despliegue productivo. La advertencia TypeORM/pg de introspección sigue visible; revisar compatibilidad antes de pg 9.
