# ADR resumidas — decisiones acordadas

| ID      | Decisión                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------- |
| ADR-001 | Producto transversal con catálogo estándar más desarrollos a medida.                                    |
| ADR-002 | Core obligatorio; módulos genéricos y personalizados opcionales.                                        |
| ADR-003 | Despliegue multiempresa compartido y dedicado, misma base de código.                                    |
| ADR-004 | Módulos nativos y aplicaciones independientes conectadas por adaptadores.                               |
| ADR-005 | Datos híbridos: entidades compartidas opcionales y propiedad de datos por módulo.                       |
| ADR-006 | White-label además de marca Innoview.                                                                   |
| ADR-007 | Innoview administra módulos/despliegues; cliente administra usuarios y roles delegados.                 |
| ADR-008 | Un tenant contiene un grupo con varias empresas y sucursales inicialmente.                              |
| ADR-009 | Compartición entre empresas configurable, privacidad por defecto.                                       |
| ADR-010 | UI Kit/App Shell para nativos; interfaz externa flexible.                                               |
| ADR-011 | Construcción desde cero sin migrar automáticamente bases de clientes existentes.                        |
| ADR-012 | Arquitectura híbrida evolutiva: monolito modular + aplicaciones externas.                               |
| ADR-013 | Backend compartido con módulos estándar desplegados y habilitación por tenant; dedicados configurables. |
| ADR-014 | Dependencias por capacidades e interfaces, no módulo concreto cuando sea razonable.                     |
| ADR-015 | Comunicación adaptativa: llamadas internas nativas, HTTP/adaptadores externos.                          |
| ADR-016 | Consistencia según proceso: transacciones locales, eventos y coordinación distribuida.                  |
| ADR-017 | UoW compartido controlado entre módulos nativos en la misma BD; interfaces públicas.                    |
| ADR-018 | Core separado de paquetes técnicos reutilizables.                                                       |
| ADR-019 | Identidad central/federada; OIDC Keycloak como primera implementación.                                  |
| ADR-020 | Autorización RBAC por alcances con políticas por recurso en Core.                                       |
| ADR-021 | Cloud PostgreSQL compartido con tenant_id, RLS y FK tenant-scoped; dedicados con DB propia.             |
| ADR-022 | OrganizationalUnit tipada como alcance para grupo, empresa y sucursal.                                  |

## Cambios

Agregar una ADR nueva con contexto, alternativas, decisión, impacto y estrategia de migración. No sobrescribir silenciosamente una decisión establecida.

## ADR-023 — Tenant y Deployment (aceptada, 2026-10-24)

- Contexto: la redacción inicial confundía aislamiento lógico e instancia de ejecución.
- Alternativas: equiparar tenant con instalación o separar ambos conceptos.
- Decisión: Tenant es el límite lógico de aislamiento de una organización cliente. Deployment es una instancia de ejecución que aloja uno o varios tenants. Inicialmente, un BusinessGroup por tenant.
- Impacto: tenant_id, RLS y FK compuestas aíslan tenants; el Core controla permisos entre empresas y sucursales. Pertenecer al mismo grupo no concede acceso implícito.
- Migración: aclaración documental de ADR-008, ADR-013 y ADR-021; aún no hay datos ni esquemas que migrar.

## ADR-024 — TypeORM inicial (aceptada, 2026-10-24)

- Contexto: concretar el ORM para PostgreSQL y el UoW previsto.
- Alternativas: SQL directo, otro ORM o TypeORM previsto en arquitectura.
- Decisión: TypeORM inicialmente, con migraciones versionadas por su CLI y synchronize: false. Keycloak continúa como proveedor central mediante OIDC (ADR-019).
- Impacto: EntityManager transaccional mediante interfaces públicas; SQL explícito para RLS/constraints cuando corresponda; roles de aplicación y migración separados.
- Migración: no hay persistencia existente. TypeORM y el driver PostgreSQL se instalarán y verificarán en 0.5; no hay entidades ni conexiones en 0.2.

## Riesgos pendientes de autorización y aislamiento

- Fase 1: bootstrap del primer administrador y consulta inicial de membresías para validar el tenant solicitado antes de establecer contexto, sin rol privilegiado de aplicación.
- Fase 2: propiedad de recursos por empresa/sucursal, herencia explícita de scopes y compartición con denegación por defecto. RLS por tenant no cubre estas políticas.
- Fase 2: constraints completas de OrganizationalUnit, referencias tipadas, unicidad y consistencia con Company/Branch.
- Fase 2: RLS fail-closed y contexto transaccional sin fugas en pools, errores y workers; verificar con PostgreSQL real y rol sin bypass.
- Fase 3: límites de delegación y efecto de revocación en sesiones y permisos vigentes.
- Fase 4: registro mínimo que conserve separados despliegue, contratación, activación, autorización y salud.

## Pendientes de validación al implementar

Versiones locales PostgreSQL/Keycloak fijadas en 0.4 y librerías/contrato OIDC seleccionados en 1.1 (ADR-025/026, OIDC.md). Sesiones/Guard integrados en 1.2 (ADR-027). Pendientes: backchannel y rotación de claves sin desconexión; constraints completas para OrganizationalUnit; auditar RLS con pool y workers; hosting/cloud y alta disponibilidad; precisar modelo contractual de módulos y licencias.

## ADR-025 — Contrato OIDC de desarrollo y aprovisionamiento (2026-10-25)

- Contexto: Fase 0 oficialmente cerrada; se requiere identidad central reproducible antes del login de aplicaciones y sin sobrescribir un IdP inicializado.
- Alternativas: realm master para aplicaciones, import con overwrite, hostname dinámico o realm separado con creación controlada y verificación de drift.
- Decisión: realm innoview separado de master; issuer público canónico http://127.0.0.1:8080/realms/innoview, puerto derivado de KEYCLOAK_HTTP_PORT y KC_HOSTNAME fijo. Clientes públicos innoview-portal/innoview-control-center con Code + PKCE S256, callbacks/logout/orígenes exactos y sin grants heredados/M2M ni administración IdP; recurso bearer-only innoview-api. Scope openid más mappers mínimos de sub y audiencia API, sin roles/email como autoridad.
- Impacto: cada app tiene identidad de cliente propia; JWT no concede acceso a tenant/empresa ni privilegios Innoview. Claves y usuarios solo en Identity. Aprovisionador Admin REST crea únicamente un realm ausente; si existe exige marca de gestión y coincidencia de campos, sin PUT/DELETE/override. Drift requiere actualización explícita revisada, no force.
- Migración: no hay clientes de aplicaciones previos del proyecto ni usuarios empresariales locales. Se crea innoview y se fija hostname en el Compose de desarrollo conservando volúmenes/master. Realms ajenos se preservan y se rechazan como destino. Producción y una futura topología containerizada requieren URLs/TLS/transporte propios sin alterar validación de issuer. Detalle en OIDC.md.

## ADR-026 — Librerías y contrato de sesiones por aplicación (2026-10-25)

- Contexto: preparar Next.js 16/NestJS 12/Node 24 sin implementar login, sesiones ni autorización de negocio en 1.1.
- Alternativas: adaptador Keycloak específico, framework de autenticación completo, tokens en navegador o integración de estándares con BFF y sesión local.
- Decisión: openid-client 6.8.8 para Code/PKCE/state/nonce/refresh/logout; jose 6.2.13 para JWKS y JWT RS256 con issuer/audiencia/tiempos/tipo. iron-session 9.0.1 seleccionada para cookie HttpOnly sellada con solo SID; tokens y refresh tokens en servidor, almacenamiento técnico/cifrado a implementar después. Instalar cada librería donde haya consumidor real: en 1.1 solo las dos primeras en herramientas de contrato.
- Impacto: claves y cookies distintas por aplicación; sesiones locales distintas de SSO, protección CSRF/Origin, validación de state/nonce y rotación single-use de refresh. No usar claims de tenant/roles del IdP como permisos Core ni email como ID global. HTTP local explícito; Secure/HTTPS obligatorio al definir producción. Sin Redis ni un framework de sesiones/UoW adelantado.
- Migración: no hay sesiones locales previas; no hay datos que migrar. Integración de cookies, almacenamiento técnico, Guards, CSRF y backchannel se implementarán en un incremento posterior tras revisión. La función de referencia de 1.1 no protege aún endpoints. Contrato y riesgos en OIDC.md.

## ADR-027 — Sesiones BFF persistentes y autenticación runtime (2026-10-25)

- Contexto: 1.1 aprobado en 6de8c38; 1.2 integra dos consumidores Next.js y un endpoint técnico NestJS sin identidad empresarial local ni autorización organizacional.
- Alternativas: tokens en cookies, Redis adicional, memoria de proceso o sesiones técnicas PostgreSQL con cookies de SID opaco.
- Decisión: paquete concreto identity-bff compartido por Portal y Control Center; TypeORM y SQL parametrizado para las operaciones atómicas de sesión. Esquemas portal_sessions/control_sessions y roles restringidos independientes, propiedad del migrador. API conserva su rol sin acceso a sesiones. SID aleatorio de 256 bits sellado con iron-session; solo hash SHA-256 en la base. Payload cifrado AES-256-GCM con IV aleatorio y AAD cliente/hash, claves de cifrado distintas de las claves de cookies y entre aplicaciones.
- Concurrencia: lease de refresh de 15 segundos, versión y actualización condicional; HTTP al IdP con timeout de 5 segundos fuera de transacciones SQL. Una renovación incierta o lease vencido revoca la sesión; nunca se retoma el refresh token anterior. Logout elimina el registro; una respuesta tardía no puede recrearlo. Expiración absoluta 8 horas e idle 30 minutos, transacciones login/logout de un uso y 5 minutos.
- Logout: local POST con Origin/CSRF; SSO RP-initiated con client_id y redirect raíz ya registrado, sin id_token_hint. Keycloak solicita confirmación cuando tiene una sesión SSO. Esta variante estándar evita transmitir el ID token al navegador; se conserva el contrato de audiencias, PKCE y clientes públicos de ADR-025. State de logout se consume en el BFF al volver a la raíz; no crea una sesión nueva. No se promete revocación inmediata de sesiones de otras aplicaciones ni de access tokens ya emitidos.
- Impacto: Guard reutilizable de autenticación y GET /auth/me con issuer/sub/clientId, sin conceder permisos. Control Center solo muestra estado técnico. Paquete compartido justificado por dos consumidores reales; sin Redis ni framework genérico. El aprovisionamiento amplía las ACL solo a los esquemas técnicos; no hay grants globales a los BFF.
- Migración: conservar contraseñas/volúmenes, agregar variables nuevas, repetir db:provision y ejecutar la migración BffSessions1792915200000. Es aditiva; las reversiones siguen bloqueadas fuera de bases descartables. Cambiar claves invalida sesiones existentes; la rotación sin desconexión queda pendiente. Se formaliza 1.2 como integración runtime; identidad local y organizaciones se reubican en incrementos posteriores, sin implementarlos.

## ADR-028 — Identidad local del Core por issuer/subject (2026-10-25)

- Contexto: 1.2 aprobado en 6f73da9; se necesita una referencia interna estable antes de implementar organizaciones y membresías.
- Alternativas: email como clave, UUID del IdP como ID interno, upsert con actualización en cada login o UUID interno y pareja OIDC única.
- Decisión: UserIdentity en esquema identity con UUID v4 propio, issuer/external_subject únicos en PostgreSQL y fechas UTC. Sin contraseñas, tokens, perfil ni afiliaciones. AuthenticationModule valida JWT y /auth/me conserva su contrato; IdentityModule usa el principal autenticado para PUT/GET /identity/me. Body con campos de identidad se rechaza. El BFF registra al completar login y muestra el UUID; sesiones válidas de 1.2 pueden resolverlo en su primera consulta autenticada.
- Concurrencia: INSERT ON CONFLICT DO NOTHING seguido de lectura independiente READ COMMITTED. La restricción única serializa insert concurrentes y la lectura obtiene el registro comprometido; no CTE con snapshot anterior, asignaciones empresariales, locks HTTP ni cambios de fechas en reautenticación. API no ofrece borrado/modificación, por lo que no hay una carrera con eliminación desde runtime.
- Persistencia: entidad TypeORM y migración UserIdentity1792922400000. Bootstrap aprovisiona esquema vacío gestionado y ACL como en Foundation; migrador conserva ownership limitado, sin CREATE global ni BYPASSRLS. API tiene solo USAGE/SELECT/INSERT en identity y defaults equivalentes para objetos futuros de ese módulo, sin alterar permisos de otros esquemas. BFF no accede a Identity. gen_random_uuid es nativo de PostgreSQL 18: uuidExtension=pgcrypto selecciona esa función en el driver, installExtensions=false impide DDL de extensiones al conectar.
- Impacto: UUID interno independiente de clientes OIDC; mismo usuario en Portal/Control Center tiene una identidad local. No se crea Tenant/Membership/RBAC/RLS ni se conceden privilegios Innoview. Se prohíbe inferir linking por email. Nuevos issuer/sub implican nueva identidad hasta definir una vinculación auditada.
- Migración: db:provision seguido de db:run, conservando filas/volúmenes previos. Tabla nueva; down sin CASCADE y CLI de reversión restringido a bases descartables. Pruebas de unicidad, concurrencia autenticada, PK/FK descartable, ACL y alineación entidad/migración. El perfil y referencias organizacionales siguen pendientes.

## ADR-029 — Retorno SSO directo al servidor, contrato OIDC v2 (2026-10-25)

- Contexto: 1.2 retornaba a raíz y dependía de JavaScript para reenviar state al callback. La revisión pide validar todo el retorno en servidor.
- Alternativas: relay desde un Server Component en raíz o callback dedicado registrado en el IdP.
- Decisión: post_logout_redirect_uri exacto /auth/logout/callback en ambos clientes, validación y consumo de state/cookie en Route Handler; luego 303 a raíz. Sin relay JavaScript ni id_token_hint. State ausente, incorrecto, duplicado o repetido falla con 400; una petición callback sin transacción logout no revoca una sesión autenticada.
- Migración: nuevo contrato innoview.contract-version=2; marca de ownership estable conservada. Instalaciones nuevas crean v2. Comando explícito oidc:migrate:logout para v1/v1 parcial: preflight completo, solo destinos legacy o nuevos conocidos y campos restantes coincidentes; PUT mínimo de atributos en cada cliente y versión del realm al final. Idempotente/reanudable, sin force, DELETE, import ni recreación. oidc:provision sigue create-only y rechaza drift; no migra implícitamente un realm previo.
- Operación: ventana de mantenimiento sin ediciones administrativas concurrentes. Admin REST no ofrece transacción/CAS para el conjunto: se comprueba antes de cada escritura y al finalizar, pero no se promete atomicidad ante un administrador concurrente. Una interrupción deja v1 parcialmente migrado y se reanuda; otros cambios se preservan y bloquean la operación. Respaldar el IdP por el procedimiento operativo vigente sin versionar exportaciones con secretos.
- Impacto: solo cambian dos destinos logout y la versión del contrato; issuer, scopes, callbacks login, audiencias, IDs, usuarios, claves y clientes ajenos permanecen. Desplegar runtime y contrato juntos, no mezclar versiones. Logout en curso de 1.2 debe reiniciarse; sesiones autenticadas pueden continuar. Sin promesa de revocación global inmediata/backchannel.
