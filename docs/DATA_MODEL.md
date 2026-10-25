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
- UserIdentity local: id, issuer, external_subject (UNIQUE(issuer, external_subject)), perfil.
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
