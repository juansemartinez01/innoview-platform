# Modelo de datos — diseño inicial, no migración definitiva

## Organizaciones

- Tenant: límite lógico de aislamiento de una organización cliente. En MVP, un BusinessGroup por tenant.
- Deployment: instancia de ejecución que aloja uno o varios tenants; no equivale a Tenant.
- BusinessGroup: conjunto de empresas relacionadas.
- Company: entidad jurídica/operativa del grupo, incluye tax_id y estado.
- Branch: sede/unidad operativa dentro de Company.
- OrganizationalUnit: nodo tipado GROUP/COMPANY/BRANCH, tenant_id, padre válido y referencia al registro específico, usado para asignar alcances.
- Jerarquía válida solo GROUP → COMPANY → BRANCH; impedir ciclos y referencias entre tenants.

## Identity

- Keycloak conserva cuentas, credenciales, MFA y sesiones del IdP.
- **UserIdentity implementada en 1.3:** tabla identity.user_identity, propiedad del módulo Identity. id UUID v4 interno (PK, gen_random_uuid nativo de PostgreSQL 18), issuer varchar(2048), external_subject varchar(255), created_at/updated_at timestamptz NOT NULL. Restricción PostgreSQL uq_user_identity_issuer_subject UNIQUE(issuer, external_subject), valores no vacíos. Los campos OIDC son exactos y sensibles a mayúsculas: no normalizar sub ni vincular por email.
- No hay email, contraseñas, tokens, perfil, tenant, roles ni membresías en UserIdentity. Resolución idempotente mediante INSERT ON CONFLICT DO NOTHING y lectura posterior con snapshot nuevo; conserva UUID y fechas al repetir. updated_at se inicializa al crear y no es last_login; aún no hay operaciones de modificación de identidad.
- La API solo obtiene la pareja desde un access token verificado. PUT /identity/me registra/resuelve y GET /identity/me consulta la identidad propia; /auth/me mantiene el principal OIDC sin persistencia. No existe búsqueda pública por UUID ajeno ni administración de identidades.
- El esquema vacío se aprovisiona con bootstrap, como los esquemas de Foundation; el migrador no recibe CREATE global sobre la base. La migración UserIdentity1792922400000 valida propiedad y crea la tabla/constraints. API solo tiene USAGE + SELECT/INSERT en identity, sin UPDATE/DELETE/DDL; BFF sin acceso. TypeORM registra la entidad con synchronize=false e installExtensions=false, sin instalar extensiones al arrancar.
- No hay FK al IdP externo ni a organizaciones todavía. La PK UUID queda disponible para futuras referencias explícitas; ninguna se implementa en 1.3. Las pruebas verifican FK y RESTRICT con un objeto técnico exclusivamente descartable, sin crear Membership.
- Cambiar issuer/sub o recrear una cuenta Keycloak produce otra identidad. No hay linking por email ni transferencia automática de privilegios; una futura vinculación requerirá una decisión y un procedimiento auditado.
- Membership: user_id, tenant_id, estado (única por combinación), revocación.
- Invitation: email objetivo, token hash, expiración, creador, consumida/revocada.
- ServiceAccount para integraciones máquina-máquina cuando se incorpore.

## Authorization

- Permission: código estable namespaceado, p.ej. sales.orders.read; proviene de módulo.
- Role: tenant, nombre, rol interno, bandera de sistema.
- RolePermission: permisos del rol.
- RoleAssignment: membership, role, organizational_unit, tenant, estado; todas las FK deben imponer mismo tenant.
- Verificar tenant activo, membresía activa, módulo habilitado, permiso, alcance organizacional y política propia de negocio.
- Herencia de permisos hacia descendientes no es automática; se establece explícitamente por política.
- Admin del cliente puede invitar y asignar roles dentro de su autoridad delegada; no puede adquirir privilegios de Innoview.

## Aislamiento de datos

- Base PostgreSQL compartida en cloud, esquemas por módulo y tenant_id en datos tenant-owned.
- RLS con política USING/WITH CHECK, FORCE ROW LEVEL SECURITY, rol app sin bypass/superuser, tenant contextual establecido con set_config(..., true) dentro de transacción.
- Claves compuestas (tenant_id, id) y FK compuestas para impedir relaciones cross-tenant no válidas.
- RLS por tenant no resuelve permisos entre empresas y sucursales: son responsabilidad de la autorización del Core, con privacidad por defecto.
- RLS es defensa adicional, no sustituye autorización backend. Aislamiento también en cachés, archivos, jobs y API.
- Instalaciones dedicadas con PostgreSQL propio y la misma semántica de seguridad.

## Registro de módulos y capacidades (posterior al foundation)

Module, ModuleVersion, Deployment, ModuleDeployment, ModuleEntitlement, ModuleActivation, ModuleConfiguration; Capability, CapabilityContract, CapabilityProvider, CapabilityRequirement, CapabilityBinding.

## Reglas de migración

- TypeORM como ORM inicial; migraciones versionadas con su CLI. synchronize: false en todos los entornos; desarrollo también utiliza migraciones.
- Validar integridad de OrganizationalUnit y scopes antes de activar roles.
- Deshabilitar un módulo no elimina datos. Evitar borrados en cascada de datos financieros o históricos.
