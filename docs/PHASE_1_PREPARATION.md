# Preparación técnica de Fase 1 — análisis, sin implementación

Fecha: 2026-10-25. Las ADR vigentes no cambian. Este documento propone contratos y orden de trabajo para revisión después de cerrar Fase 0; no autoriza implementación automática.

Actualización 1.1: Fase 0 oficialmente aprobada y contrato/configuración OIDC implementado en OIDC.md (ADR-025/026). Las propuestas siguientes son preparación de módulos posteriores, no código implementado. Recomendación a revisar para 1.2: integración runtime de Identity y sesiones antes de exponer datos organizacionales; no se avanza sin autorización.

## Dependencias y responsabilidades

| Área               | Responsabilidad propuesta                                                                             | Dependencias y límites                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity           | Validar identidad OIDC y mantener la referencia local UserIdentity, única por issuer/external_subject | Keycloak conserva credenciales, MFA y sesiones del IdP. Email no es identificador estable. Core conserva la identidad referenciada; no almacena contraseñas                          |
| Organizations      | Tenant, BusinessGroup, Company y Branch con su jerarquía y estado                                     | Un BusinessGroup por tenant inicialmente (ADR-008/023). No compartir datos entre empresas por pertenecer al grupo. No incorporar procesos de negocio                                 |
| Memberships        | Relación única identidad/tenant, estado activo/revocado y consulta de pertenencias                    | Depende de UserIdentity y Tenant. Membresía no equivale a rol ni permiso. Invitaciones y administración delegada siguen en Fase 3                                                    |
| OrganizationalUnit | Alcance tipado GROUP/COMPANY/BRANCH vinculado al registro organizacional correspondiente              | Depende de Organizations. Propuesta: propiedad dentro de Organizations, sin servicio ni paquete independiente; confirmar antes de implementar. RoleAssignment la consumirá en Fase 2 |

Dependencias de datos: Identity → UserIdentity; Organizations → Tenant/Group/Company/Branch → OrganizationalUnit; UserIdentity + Tenant → Memberships. OrganizationalUnit no necesita Memberships para existir; los permisos futuros usarán ambas relaciones.

## Orden propuesto por incrementos verificables

1. **1.1 — Contrato de identidad y sesiones.** Precisar issuer canónico, realm de desarrollo separado de master, clientes portal/control-center/API, audiencia y estrategia de sesión. Mantener Authorization Code + PKCE, sesión HttpOnly y validación backend de firma/JWKS, issuer, audiencia y expiración. Definir login/logout, protección CSRF, redirecciones permitidas y tratamiento de revocación. Elegir librerías y versiones compatibles en ese incremento, sin agregar almacenes o tecnologías sin necesidad. Separar identidad autenticada de autorización Innoview/cliente. Primer resultado a revisar: contrato y flujo técnico con sus criterios de prueba, antes de exponer datos de organizaciones.
2. **1.2 — Identidad referenciada y base organizacional.** Diseñar las migraciones versionadas de UserIdentity y Tenant/BusinessGroup/Company/Branch con claves, estados y propiedad por módulo. Identity puede pertenecer a distintos tenants; identidad global no concede acceso por sí misma. Crear solamente el mínimo de organizaciones necesario para probar el flujo. Ningún alta automática de tenant o privilegio administrativo por un claim del frontend.
3. **1.3 — Integridad de OrganizationalUnit.** Concretar constraints: correspondencia uno a uno con el registro específico, padre válido GROUP → COMPANY → BRANCH, unicidad, ciclos y referencias restringidas al mismo tenant. Resolver cómo mantener consistente la jerarquía con Company/Branch dentro de una transacción local. Verificar restricciones con PostgreSQL real antes de asignar alcances.
4. **1.4 — Memberships y contexto accesible.** Relación única identidad/tenant, revocación y validación de estados. Consultar pertenencias desde backend antes de aceptar un contexto. Definir bootstrap controlado de organizaciones y primera membresía sin superusuario de aplicación ni asignación administrativa libre. No introducir todavía el sistema completo de RBAC.
5. **1.5 — Selector mínimo y pruebas de aceptación.** API de organizaciones accesibles y selección de contexto basada en membresías verificadas. Probar dos tenants para el mismo usuario, uno ajeno, revocación y manipulación de identificadores. La navegación no concede acceso. No publicar operaciones tenant-owned sin controles backend; RBAC, políticas RLS reales y pruebas exhaustivas de aislamiento permanecen en Fase 2 según el plan aprobado.

## Preparación de persistencia necesaria durante Fase 1

- La infraestructura actual administra solo foundation y platform_meta. Las nuevas migraciones deberán declarar explícitamente los esquemas de Core: extender el aprovisionamiento y la lista de esquemas aceptados por el migrador, sin eliminar validaciones de privilegios ni conceder CREATE a app.
- Configurar entidades explícitas por esquema y migraciones propias por módulo. El default schema del migrador es platform_meta para el historial: no usar ese default para entidades empresariales nuevas.
- Mantener metadata de migraciones fuera del alcance de app. Usar claves/FK compuestas por tenant donde corresponda; UserIdentity global requiere un tratamiento explícito diferente al de datos tenant-owned.
- Diseñar la consulta inicial de identidad/membresías que precede al contexto tenant. No resolver ese arranque mediante credenciales bootstrap ni un rol con BYPASSRLS.
- Antes de RLS en Fase 2, concretar UoW/contexto transaccional, set_config local a la transacción, comportamiento fail-closed y pruebas con reutilización del pool. No inferir aislamiento de las pruebas técnicas de Fase 0.

## Preguntas que deben resolverse antes de implementar su incremento

- Identidad: URL canónica del issuer cuando navegador y API acceden a Keycloak, clientes separados, audiencias, almacenamiento/ciclo de sesiones y revocación.
- Organizaciones: catálogo de estados y transiciones, política de bootstrap y referencias de datos globales frente a tenant-owned.
- OU: propiedad definitiva del subdominio, constraints completas y política de herencia explícita; la herencia no se presume.
- Memberships: efectos de revocar pertenencia sobre solicitudes/sesiones en curso y alcance del bootstrap administrativo.
- Seguridad: qué endpoints se habilitan en cada incremento antes de RBAC/RLS; cada uno debe verificar pertenencia desde backend y negar acceso por defecto.

No se implementan entidades, OIDC de aplicaciones, permisos empresariales ni RLS en este análisis. No se cambia la frontera Tenant/Deployment ni las ADR cerradas. Toda decisión arquitectónica nueva se registrará en DECISIONS.md cuando se acuerde.
