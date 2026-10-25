# Identity — contrato OIDC y runtime BFF

Incremento 1.1 aprobado en 6de8c38. Incremento 1.2 implementado, pendiente de revisión. ADR-025/026/027. No hay UserIdentity local, organizaciones, Memberships, RBAC ni RLS. Keycloak autentica; Core autorizará. Una identidad válida en Control Center no concede administración Innoview.

## Autoridad, clientes y scopes

Realm de aplicación **innoview**, separado de **master**. Identidad estable `(issuer, sub)`, nunca email como clave global ni roles/tenant_id del token como autorización. No se almacenan contraseñas empresariales en Platform.

Issuer local canónico: **http://127.0.0.1:8080/realms/innoview**. KEYCLOAK_HTTP_PORT cambia la publicación y KC_HOSTNAME; actualizar también OIDC_ISSUER si se modifica. No alternar localhost/127.0.0.1 ni reemplazar el issuer por keycloak:8080. Las aplicaciones corren en el host. Discovery desde Docker conserva el issuer público; una futura containerización completa necesitará resolver esa autoridad desde todos los consumidores sin desactivar issuer/TLS.

| Cliente                 | Contrato                  | Callback                            | Post-logout / origen                           |
| ----------------------- | ------------------------- | ----------------------------------- | ---------------------------------------------- |
| innoview-portal         | Público, Code + PKCE S256 | http://127.0.0.1:3000/auth/callback | http://127.0.0.1:3000/ / http://127.0.0.1:3000 |
| innoview-control-center | Público, Code + PKCE S256 | http://127.0.0.1:3001/auth/callback | http://127.0.0.1:3001/ / http://127.0.0.1:3001 |
| innoview-api            | Recurso bearer-only       | Ninguno                             | Ninguno                                        |

Scope solicitado **openid**. Scope predeterminado propio innoview-api-access agrega sub y audiencia innoview-api al access token mediante dos mappers explícitos, sin agregar audiencia API al ID token. Sin scopes profile/email/roles/offline_access, wildcards, privilegios administrativos, Implicit, password grant, service accounts, device grant, CIBA o token exchange para aplicaciones. fullScopeAllowed=false. Sub requiere mapper explícito al retirar los scopes estándar de Keycloak 26; su emisión real está probada.

Clientes públicos con PKCE y BFF: el intercambio ocurre en servidor, no en una SPA. No hay client secrets que distribuir. Un cambio futuro a clientes confidenciales requiere decisión y actualización explícitas.

## Aprovisionamiento del IdP

Fuente sin usuarios ni secretos: infra/keycloak/contract.mjs. Keycloak genera/persiste sus claves en PostgreSQL Identity. Desde raíz:

```powershell
docker compose up -d --wait --wait-timeout 240
pnpm oidc:provision
pnpm oidc:check
```

El administrador local de master obtiene un token temporal admin-cli para esta operación controlada; nunca se entrega a aplicaciones ni se imprime. El aprovisionador crea únicamente un realm ausente. Si existe, requiere marca de gestión y coincidencia de flags/clientes/scopes/mappers; realiza solo lecturas, sin PUT/DELETE/force/override. Drift o realm ajeno: falla preservándolo. No sobrescribir configuraciones ni borrar volúmenes para resolver diferencias. check verifica además discovery, issuer y JWKS públicos utilizables, exclusivamente con claves públicas.

## Runtime y rutas

Ambas aplicaciones usan packages/identity-bff, con dos consumidores reales y sin reglas empresariales. Next.js Route Handlers en runtime Node; los componentes cliente solo reciben estado mínimo y token CSRF, nunca access/refresh tokens.

| Método/ruta               | Comportamiento                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET /                     | Pantalla mínima: iniciar sesión, identidad autenticada, logout local/SSO                                               |
| GET /auth/session         | Estado mínimo desde el BFF; valida/renueva sesión y consulta la API; crea sesión anónima para CSRF cuando corresponde  |
| POST /auth/login          | Exige cookie, Origin exacto y CSRF; crea transacción de un uso y redirige al IdP con Code/PKCE/state/nonce             |
| GET /auth/callback        | Consume atómicamente la transacción, valida state/nonce/issuer y firma del ID token, intercambia code y crea SID nuevo |
| POST /auth/logout         | Exige Origin/CSRF, elimina sesión y cookie; opcional sso=true inicia logout en Keycloak                                |
| GET /auth/logout/callback | Consume state de logout de un uso, borra cookie transitoria y vuelve a raíz; no crea sesión                            |
| GET API /auth/me          | Guard JWT; devuelve solo issuer, subject y clientId; 401 ante credenciales inválidas                                   |

Retorno admitido exclusivamente `/`; se rechazan destinos arbitrarios, incluso si el navegador los envía. Callback se reconstruye desde la configuración confiable, no desde Host/X-Forwarded-Host. Cookies y respuestas de sesión no se cachean; logging de URLs de peticiones Next desactivado para evitar registrar códigos OIDC. Errores de autenticación genéricos, sin respuestas del proveedor, contraseñas, cabeceras ni SQL sensible.

### Login y CSRF

La sesión anónima entrega un token CSRF ligado al registro servidor. POST requiere Origin exactamente igual al origen configurado y token CSRF válido; también rechaza Sec-Fetch-Site cross-site. Formularios de mismo origen aportan Origin automáticamente. Login guarda state, nonce y PKCE verifier independientes dentro del payload cifrado, con duración de cinco minutos y vínculo al SID sellado del navegador.

Callback elimina el registro con DELETE RETURNING antes del intercambio HTTP, incluso si la validación falla. openid-client comprueba state, nonce, issuer y audiencia del ID token; enableNonRepudiationChecks exige su firma RS256. Códigos/transacciones no se reintentan. Una petición callback sin transacción login no destruye una sesión autenticada. Se genera SID nuevo y cookie nueva después del éxito; iron-session 9 no permite reutilizar un objeto destruido.

### Cookies y almacenamiento

Cookie solo con SID aleatorio de 256 bits, sellado por iron-session. Nombres locales innoview.portal.sid / innoview.control.sid; HttpOnly, SameSite=Lax, Path=/, sin Domain. Con HTTPS: nombres __Host- específicos y Secure=true. HTTP solo con AUTH_ENV=development y AUTH_ALLOW_HTTP=true, para URLs 127.0.0.1. Fuera de esa excepción las URLs requieren HTTPS; PostgreSQL requiere DB_SSL=require con verificación de certificados. No derivar estas decisiones de headers enviados por clientes.

Cookies no se aíslan por puerto: claves, nombres, roles y esquemas son distintos. Cada proceso desplegado debe recibir únicamente sus propias credenciales y claves, nunca las del otro frontend ni bootstrap/migrador. El .env raíz es una comodidad local; no distribuirlo como entorno de producción. Los tests lanzan procesos con variables mínimas y prueban que un BFF no acepta el sello del otro.

Tablas técnicas portal_sessions.sessions y control_sessions.sessions, propietarias del migrador. Solo su rol BFF tiene USAGE y CRUD en su esquema; API no tiene acceso, los BFF no pueden DDL ni acceder al esquema del otro. TypeORM con synchronize=false, sin migraciones automáticas ni logging SQL. No hay entidades empresariales.

En la base solo se conserva SHA-256 del SID; payload AES-256-GCM contiene tokens, identidad, CSRF y secretos de transacción. IV aleatorio por escritura, AAD cliente/hash; claves de 32 bytes independientes entre aplicaciones y de las claves de cookie. Nunca tokens en localStorage/sessionStorage, cookies o respuestas BFF al navegador. Las claves se inyectan al servidor, no se guardan en PostgreSQL. Cambiarlas desconecta sesiones previas; rotación sin desconexión pendiente.

### Expiración y refresh concurrente

Access token 300 segundos, code 60 segundos; sesión local absoluta ocho horas e idle treinta minutos. Transacciones login/logout y sesión anónima cinco minutos. GET /auth/session comprueba vencimiento y revocación en servidor; renovar no extiende la expiración absoluta. La pantalla técnica verifica al cargar; recargar vuelve a comprobar/renovar. No hay polling que mantenga viva una sesión sin actividad. Limpieza oportunista acotada de registros vencidos, sin tareas/infraestructura adicionales.

Refresh online rotado y single-use (revokeRefreshToken=true, maxReuse=0). Si quedan menos de treinta segundos de access token, un UPDATE condicional obtiene lease de quince segundos y versión. Competidores esperan y releen; un ganador persiste mediante comparación de lease/versión y libera. Timeout HTTP de cinco segundos. No hay BEGIN ni locks transaccionales sostenidos durante llamadas a Keycloak.

Un lease vencido o refresh con resultado incierto revoca la sesión: nunca recuperar el lease reutilizando el token anterior, que pudo consumirse antes de un crash. Logout elimina la fila; una respuesta tardía no puede recrearla. La espera se acota a seis segundos y falla cerrada. Esto favorece seguridad frente a continuidad durante un fallo del proveedor/proceso; el usuario puede volver a iniciar sesión.

### Logout y límites de revocación

Logout local elimina inmediatamente el registro y la cookie tras validar CSRF; una copia de la cookie deja de autenticar. SSO logout elimina primero la sesión local y usa RP-initiated logout con client_id, post_logout_redirect_uri raíz registrado y state de un uso. Se omite id_token_hint: Keycloak muestra confirmación al usuario con sesión SSO, sin transmitir el ID token al navegador. Esta variante estándar queda registrada en ADR-027, sustituyendo el hint previsto en 1.1 sin cambiar clientes/redirects. Al volver a raíz la UI remite state al callback servidor; no puede reactivar sesión.

Sesión IdP y sesiones locales son distintas. Logout local de Portal no cierra Control Center ni Keycloak. Logout SSO no borra al instante cookies ajenas ni revoca access tokens ya emitidos. Otras apps detectan el fallo de refresh o vencimiento; access tokens pueden conservar validez hasta cinco minutos. Backchannel logout/revocación distribuida no se implementan en 1.2; no se promete revocación instantánea global.

## NestJS

IdentityModule exporta AuthenticationGuard e IdentityVerifier reutilizables. GET /auth/me usa el Guard y Cache-Control:no-store. JWKS remoto derivado solo del issuer configurado, nunca de iss/jku/x5u del token. Cache diez minutos, timeout cinco segundos y cooldown treinta segundos; fallos cerrados.

Verifica firma RS256, issuer exacto, aud que contenga innoview-api, exp/iat/sub/azp requeridos, expiración y nbf cuando exista, maxTokenAge cinco minutos y tolerancia de cinco segundos. Requiere typ=Bearer y azp de Portal o Control Center. Rechaza ID tokens, firmas/claves desconocidas y otros algoritmos/clientes. No convierte claims de roles, tenant, email o permisos en autoridad Core; no hay endpoints empresariales ni administración.

## Preparar el entorno

Seguir README para generar variables locales sin sobrescribir contraseñas previas. Nuevas: OIDC_ISSUER, AUTH_ENV/ALLOW_HTTP/API_ORIGIN, PORTAL/CONTROL_ORIGIN, DB_PORTAL/CONTROL_USER/PASSWORD y cuatro claves *_COOKIE_PASSWORD / *_TOKEN_PASSWORD. Cada clave: 32 bytes aleatorios codificados en 64 caracteres hexadecimales; credenciales distintas entre todos los roles. Nada NEXT_PUBLIC contiene secretos.

```powershell
pnpm install --frozen-lockfile
docker compose up -d --wait --wait-timeout 240
pnpm db:provision
pnpm db:run
pnpm db:show
pnpm oidc:provision
pnpm oidc:check
pnpm dev
```

db:provision funciona sobre la base existente, agrega roles/esquemas gestionados y reconcilia ACL mínimas sin borrar datos. BffSessions1792915200000 crea las dos tablas técnicas; no modifica la migración histórica. Reversión bloqueada fuera de bases descartables. Para crear una cuenta de desarrollo utilizar la consola Keycloak, realm innoview, no master: usuario habilitado, perfil requerido completo y contraseña local, sin asignar privilegios realm-management. No guardar esos datos en el repositorio ni usar administradores master para login de aplicaciones. No se implementa administración de usuarios en Innoview.

Abrir http://127.0.0.1:3000 y http://127.0.0.1:3001, pulsar Iniciar sesión y autenticarse en Keycloak. Ambos muestran solo estado técnico y subject. Usar logout local o la opción SSO con confirmación IdP. El mismo usuario puede autenticar en ambas apps sin obtener autorización empresarial ni administrativa.

## Librerías, verificación y pendientes

openid-client **6.8.8**, iron-session **9.0.1**, jose **6.2.13**; Node **24.22.1**, Next.js **16.4.3**, NestJS **12.2.0**, TypeScript **6.0.3**. Las tres primeras tienen consumidores runtime y están verificadas: openid-client/iron-session en BFF, jose en NestJS. TypeORM/pg conservan **1.1.2/8.23.1**. Next transpila el paquete BFF y mantiene TypeORM/pg externos; driver PostgreSQL explícito para evitar require dinámico incompatible con el bundler.

Verificación local de cierre: instalación congelada, lint, formato, typecheck y cuatro builds satisfactorios. pnpm test reporta 32 resultados sin fallos/omitidos: 12 PostgreSQL, 9 contrato OIDC/JWT y 11 runtime (incluyen pruebas principales que agrupan subpruebas). pnpm dev y servidores compilados respondieron HTTP 200 en las tres aplicaciones; ambos BFF emitieron cookies HttpOnly y /auth/me sin token devolvió 401. Migración aditiva aplicada/consultada en la base local existente y oidc:check correcto, sin eliminar volúmenes ni crear usuarios habituales.

Correcciones verificadas: driver pg explícito/externo para Next; creación de objeto cookie nuevo después de destroy en iron-session 9; carga local con loadEnvFile antes del CLI Next para evitar --env-file dentro de NODE_OPTIONS. La prueba de code replay abre luego una sesión legítima nueva porque Keycloak puede revocar la sesión del cliente al detectar reutilización; no se debilita esa defensa para probar refresh. La entrega identifica el commit y el run de CI revisado.

```powershell
docker compose -f compose.test.yaml up -d --wait --wait-timeout 180
pnpm test
docker compose -f compose.test.yaml down
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
```

Pruebas reales con PostgreSQL tmpfs y Keycloak dev-mem descartables, puertos separados, test_bootstrap/test_admin y secretos aleatorios. Se exige innoview ausente antes de crear fixtures; nunca se modifican usuarios/volúmenes de desarrollo. La suite runtime crea base/roles únicos, clientes en puertos altos 13000/13001 y API 13002, arranca los tres servidores y elimina solo sus fixtures al terminar. Artefactos Next aislados en .next-runtime-test; no apuntar los TEST_* a servidores habituales. No se simulan los endpoints de Next, Nest ni Keycloak. Son pruebas HTTP de integración, no automatización visual de navegador.

Se comprueban login de ambos clientes, state/nonce/issuer incorrectos, reutilización de callback/code, CSRF/redirects, cookies HttpOnly y sellos separados, roles y cifrado, sesiones vencidas/revocadas, refresh concurrente, lease incierto, logout real local/SSO, /auth/me y 401. Tokens con audiencia incorrecta y expiración real son firmados por el IdP descartable; negativos de firma usan clave ajena y están diferenciados. Logs y respuestas se comparan con secretos/tokens generados. El contrato 1.1 mantiene sus pruebas de aprovisionamiento/discovery/JWKS/drift y criptografía sintética. No es validación de autorización organizacional ni RLS.

Pendientes: backchannel/revocación global inmediata, rotación de claves sin desconexión, operaciones/observabilidad y política HTTPS/IdP de producción. La persistencia de sesión no constituye UserIdentity local ni Membership. No avanzar más allá de 1.2 sin revisión.

Fuentes oficiales: [openid-client](https://github.com/panva/openid-client/tree/v6.8.8), [iron-session](https://github.com/vvo/iron-session/tree/v9.0.1), [jose](https://github.com/panva/jose), [cookies Next.js](https://nextjs.org/docs/app/api-reference/functions/cookies), [NestJS Guards](https://docs.nestjs.com/guards), [Keycloak hostname](https://www.keycloak.org/server/hostname), [Admin REST 26.8.1](https://www.keycloak.org/docs-api/26.8.1/rest-api/index.html), [RP-initiated logout](https://www.keycloak.org/securing-apps/oidc-layers).
