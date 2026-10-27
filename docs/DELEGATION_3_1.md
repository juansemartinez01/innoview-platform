# Administración delegada 3.1 — contrato y evidencia

Base aprobada: `753def7f665ca979af21a799ad72d52fde7c1ad9`. Fase 2 cerrada por Dirección. Solo 3.1 está autorizado; este informe no declara su aprobación.

## Operación HTTP

`POST /admin/role-assignments`, Bearer access token Keycloak, encabezado `X-Tenant-Id` UUID canónico. El tenant es un candidato. Body exacto, sin campos adicionales:

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "membershipId": "00000000-0000-4000-8000-000000000002",
  "roleId": "00000000-0000-4000-8000-000000000003",
  "scopeType": "COMPANY",
  "scopeUnitId": "00000000-0000-4000-8000-000000000004",
  "reason": "Asignación explícita autorizada"
}
```

Los UUID anteriores son ilustrativos y no corresponden a fixtures instaladas. GROUP/COMPANY/BRANCH son alcances exactos. Respuesta 201, también para replay: `{ "id": "UUID", "status": "ACTIVE" }`. `Cache-Control: no-store` y `X-Correlation-Id` en respuesta. No hay UI administrativa ni endpoints de creación/composición/revocación de roles.

JWT ausente/inválido → 401; facultad, contención o namespace reservado → el mismo 403; referencias ajenas/indisponibles o contrato inválido → 404 uniforme; requestId incompatible → 409; transitorio reconocido → 503/Retry-After; error desconocido → 500 genérico. La respuesta no incluye SQL, composición RBAC, tokens o datos ajenos.

## Frontera y transacción

AuthenticationGuard emite el Principal original inmutable, marcado tras verificar JWT/JWKS. El servicio rechaza clones antes de adquirir conexión. El pool `authorization.delegation-source` usa exclusivamente `DB_AUTHORIZATION_DELEGATION_*`; el DataSource general sigue siendo app y los lectores RR/read-only de Fase 2 no cambian.

La transacción READ COMMITTED verifica el marker del rol, establece issuer/sub LOCAL, resuelve Identity existente mediante su contrato y busca la Membership propia ACTIVE. No hace altas. Establece actor/identity/Membership/tenant/reason/request LOCAL y lock_timeout 8 s. Bloquea la revisión existente antes de cualquier DML administrativo; si falta, falla cerrado. Lee referencias mediante contratos de sus propietarios y comprueba contención. Pending ledger, INSERT, revisión, auditoría y resultado se confirman juntos.

El contrato SQL de Memberships y Organizations sigue siendo propiedad de esos módulos. La migración congela una copia versionada de sus relaciones concretas para no cambiar migraciones históricas al evolucionar el runtime. No es permiso para que módulos comerciales consulten tablas privadas.

La FK `authorization.operation.tenant_id` conserva su integridad y pasa a DEFERRABLE INITIALLY IMMEDIATE. Solo el escritor delegado usa SET CONSTRAINTS DEFERRED. Su propósito es no retener anticipadamente KEY SHARE sobre Tenant, que impediría observar un cambio de Organizations antes de la comprobación diferida. Las FK siguen comprobándose al commit; no se desactivan triggers ni RLS. El escritor técnico conserva el modo inmediato.

Los escritores técnicos y delegados bloquean primero tenant_revision. El técnico puede inicializar la revisión con contexto técnico válido, sin alterar su contador. Para preservar conflictos globales de requestId, solo el operador técnico puede leer una operación completada del request LOCAL fuera del tenant candidato; no se amplía la visibilidad app/delegada ni sus escrituras. Las operaciones de otro tenant no comparten fila de revisión.

## Base de datos

Migración 15: `DelegatedAssignments1793142000000`. Sin tablas nuevas ni modificación de migraciones anteriores. Agrega procedencia humana al ledger/eventos y UNIQUE `(tenant_id,id,user_identity_id)` a Membership. FK compuesta desde ambos registros prueba coherencia del actor; CHECK/FK poblados usan NOT VALID + VALIDATE. Es una excepción referencial nativa controlada, creada por migrador, sin REFERENCES runtime.

Catálogo migrator-only: authorization.role.define, authorization.role.compose, authorization.assignment.grant, authorization.assignment.revoke y authorization.delegation.grant. Solo assignment.grant tiene uso HTTP en 3.1; existir en catálogo no concede nada.

Identity mantiene su contrato app append/read y agrega RLS para la lectura delegada exacta por issuer/sub LOCAL. La credencial delegada solo lee id/issuer/subject, nunca otras identidades bajo el contexto fijado. Memberships permite columnas mínimas de la identidad contextual y la Membership destino candidata dentro del mismo tenant. Organizations permite columnas mínimas de disponibilidad, bajo frontera tenant RESTRICTIVE. No se amplían las políticas app existentes.

| Credencial            | Escritura                                                                                          | Lectura                                                                             | Exclusiones                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| App                   | Identity append y probe técnico anteriores                                                         | Evaluación efectiva contextual aprobada                                             | Sin escritura RBAC ni secretos operativos globales                                                               |
| Delegation            | INSERT RoleAssignment/Operation/auditoría derivada; UPDATE result/completed_at y revisión derivada | Referencias mínimas propietarias; catálogo/concesiones; operación del request LOCAL | Sin UPDATE RoleAssignment, Role/RP/Permission/CatalogVersion, sesiones, repair, DDL, ownership o roles heredados |
| Authorization técnico | Operaciones técnicas auditadas; bootstrap INNOVIEW_OPERATOR                                        | Tablas propias/contexto y replay del request completado                             | Sin catálogo editable ni credencial en HTTP                                                                      |
| Migrador              | DDL y catálogo versionados                                                                         | Verificación técnica controlada                                                     | No es runtime                                                                                                    |

`require_delegated_authority()` es SECURITY INVOKER y se ejecuta BEFORE INSERT y mediante constraint trigger diferido. Exige actor/membresía del ledger/contexto, Memberships ACTIVE, rol ACTIVE, unidad/ancestros disponibles, assignment.grant efectivo exacto y contención por conjuntos de permisos efectivos. Un rol destino con cualquier referencia histórica a authorization.* queda prohibido. No usa nombres de rol como autoridad. La revocación sigue siendo terminal; reasignar requiere otra fila y operación.

## Bootstrap técnico reproducible

Agregar la nueva pareja en `.env` local con contraseña aleatoria independiente (mínimo 16 caracteres). Detener API/escritores, ejecutar `pnpm db:provision`, `pnpm db:run`, nuevamente `pnpm db:provision` y `pnpm db:diagnose`; reiniciar API. No borrar volúmenes ni usar down en la base habitual.

El launcher `authorization:technical` excluye app, migrador, bootstrap, sesiones e IdP. El escritor usa Authorization técnico. Únicamente grant-admin abre además pools propietarios independientes Memberships/Organizations para la preparación previa ya existente; no hace escrituras ajenas ni transporta estas credenciales a HTTP.

Preparar un rol mediante contratos técnicos auditados, conservando los requestId para reintentar:

```powershell
pnpm authorization:technical create-role --tenant $tenantId --name "Administrador inicial" --description "Bootstrap revisado por Innoview" --actor $operador --reason $motivo --request-id $crearRolRequestId
pnpm authorization:technical grant-permission --tenant $tenantId --role $roleId --permission authorization.assignment.grant --actor $operador --reason $motivo --request-id $concederAdministracionRequestId
pnpm authorization:technical grant-permission --tenant $tenantId --role $roleId --permission foundation.probe.read --actor $operador --reason $motivo --request-id $concederLecturaRequestId
pnpm authorization:technical grant-admin --tenant $tenantId --membership $membershipId --role $roleId --scope-type COMPANY --scope-unit $companyUnitId --actor $operador --reason $motivo --request-id $bootstrapRequestId
```

Cada variable debe referir a una referencia interna existente y revisada; cada requestId es un UUID explícito distinto, retenido para replay. foundation.probe.read es la demostración técnica aprobada, no un permiso comercial. Crear/componer un rol ordinario utiliza los mismos dos primeros contratos, sin códigos authorization.*. Ningún login, selección de tenant o Membership ejecuta este bootstrap.

## Idempotencia y límites

Reutiliza el ledger global y el dispatcher de fingerprint_version persistida v2; la huella delegada incluye módulo, operación, tenant, actor humano, Membership actor y argumentos. Replay idéntico exige autoridad y referencias todavía disponibles; perderlas deniega sin nueva ejecución ni exposición del resultado histórico. Un request incompatible conserva conflicto. El resultado histórico jamás reactiva una concesión.

Retención: authorization.operation se conserva sin TTL ni limpieza destructiva. No se elimina sin sustituir previamente su función global de impedir reutilización de requestId mediante un mecanismo durable revisado. Auditoría permanece append-only; un archivo futuro deberá preservar integridad, procedencia, consultas de incidentes y vínculos al ledger, verificarse antes de retirar almacenamiento activo y tener política de acceso/retención aprobada. 3.1 no implementa borrado.

H-2: contención al INSERT y commit no es una garantía eterna ante cambios técnicos posteriores de un rol compartido. Innoview gobierna esa composición. **Bloquea composición delegada en 3.2/3.3** hasta revalidar asignaciones afectadas o adoptar composición inmutable.

H-3: la revisión serializa cambios RBAC dentro de un tenant; READ COMMITTED permite nuevas lecturas durante la comprobación diferida. No se toman locks escritores de otros módulos. Persisten carreras de revocaciones confirmadas después de la última comprobación; toda operación empresarial posterior sigue usando el evaluador efectivo. No caché ni autoridad transportada desde historial.

Una credencial SQL comprometida que controla GUC puede falsificar atribución humana. PostgreSQL controla tenant, operaciones y contención bajo ese contexto; no autentica criptográficamente al usuario. El backend verificado y el aislamiento de secretos siguen siendo parte del modelo de confianza.

## Matriz de seguimiento

| Asunto      | Estado/objetivo                                                                | Responsable             |
| ----------- | ------------------------------------------------------------------------------ | ----------------------- |
| G-1         | Documentación corregida; prueba UPDATE directo/repair con timeout y rollback   | Platform Core           |
| G-2         | UUID/request/tenant ausente o NULL falla antes de usar la llave transaccional  | Platform Core           |
| G-7         | Evidencia local identifica árbol de trabajo/base; CI identifica SHA/run reales | Calidad/CI              |
| H-2         | Bloqueante para composición delegada futura, no para asignación contenida 3.1  | Dirección/Authorization |
| G-4         | Comparación tenant-scoped del directorio, 3.2 con pruebas                      | Organizations           |
| G-5         | Verificación streaming de backup, 3.2 con pruebas                              | Operaciones             |
| G-9         | Deduplicación temprana permissionsFor, 3.2 solo con medición diferencial       | Authorization           |
| G-3/G-6/G-8 | Informativos de la revisión; sin ampliar alcance 3.1                           | Dirección/Auditor       |

Pruebas y benchmark deben completarse antes de publicar; los resultados finales y el SHA/Actions se informan después de ejecutar y verificar. No se atribuye una medición de árbol de trabajo a un SHA futuro.
