# OIDC — contrato e identidad centralizada (incremento 1.1)

Fecha: 2026-10-25. ADR-025/026. Realm y clientes configurados y verificados; login de aplicaciones, sesiones persistentes y Guards todavía no implementados. No hay entidades empresariales ni concesión de acceso a tenants.

## Topología y autoridad

Keycloak autentica; Platform Core autoriza. El realm de aplicación es **innoview**, separado de **master**, reservado para administrar el IdP. Identidad estable futura: `(issuer, sub)`, nunca email como clave global. Un JWT válido, un azp de Control Center o un rol de Keycloak no conceden acceso a empresas, tenants o administración Innoview.

En desarrollo el issuer canónico es **http://127.0.0.1:8080/realms/innoview**. KEYCLOAK_HTTP_PORT cambia tanto la publicación como KC_HOSTNAME y el issuer del contrato. Navegador, Next.js y NestJS ejecutados en el host usan esa misma URL. No alternar localhost/127.0.0.1, no sustituir issuer por un hostname interno ni deshabilitar su comprobación.

KC_HOSTNAME contiene la URL pública completa. Discovery mantiene el issuer canónico incluso al consultarlo desde la red Docker mediante keycloak:8080; esto se verificó. Actualmente las aplicaciones corren en el host, por lo que también alcanzan directamente JWKS/token/logout por la URL canónica. Si se containerizan después, resolver esa URL pública mediante DNS/proxy compartido, o adaptar explícitamente el transporte backchannel manteniendo el issuer y la validación TLS. No cambiar los claims para corregir un problema de red. La topología containerizada completa no se implementa en 1.1.

Esta URL HTTP y sslRequired=none son exclusivos del entorno loopback de desarrollo. Producción requiere issuer HTTPS estable, redirecciones de sus dominios y política TLS independiente; no reutilizar este realm como configuración de producción.

## Clientes y scopes

| Cliente                 | Tipo/flujo                                                         | Callback exacto                     | Post-logout y origen permitido                        |
| ----------------------- | ------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------- |
| innoview-portal         | Público, Authorization Code + PKCE S256                            | http://127.0.0.1:3000/auth/callback | http://127.0.0.1:3000/ y origen http://127.0.0.1:3000 |
| innoview-control-center | Público, Authorization Code + PKCE S256                            | http://127.0.0.1:3001/auth/callback | http://127.0.0.1:3001/ y origen http://127.0.0.1:3001 |
| innoview-api            | Recurso bearer-only, sin grants interactivos ni machine-to-machine | Ninguno                             | Ninguno                                               |

Sin wildcards, client secrets de aplicaciones, Implicit Flow, password grant, service accounts, device grant, CIBA o token exchange para los clientes frontend. fullScopeAllowed=false. No se asignan privilegios administrativos de Keycloak. Los clientes internos creados por Keycloak son infraestructura del IdP; no son clientes de negocio ni origen de permisos Core.

Elegimos clientes públicos con PKCE, compatible con intercambio Code desde un backend Next.js sin distribuir secretos de cliente. Esto no convierte a las apps en SPA con tokens en navegador: el contrato de integración es BFF, con intercambio y almacenamiento de tokens exclusivamente servidor. Alternativa considerada: clientes confidenciales con secretos por entorno; se evita introducir su distribución antes de necesitarla. Un cambio de tipo futuro requiere migración explícita de configuración, no una reconciliación silenciosa.

Scope solicitado: **openid**. Scope predeterminado propio **innoview-api-access**, oculto del texto scope del token, agrega únicamente `sub` mediante oidc-sub-mapper y audiencia `innoview-api` mediante oidc-audience-mapper. No agrega la audiencia API al ID token. Sin profile, email, roles u offline_access como scopes de estos clientes. `sub` requiere mapper explícito en Keycloak 26 al retirar scopes estándar; fue detectado y corregido mediante una emisión real.

Los callbacks están registrados para la integración posterior: hoy esas rutas no implementan login y pueden devolver 404. Los tests interceptan el código sin llamar a las aplicaciones; no agregan pantallas ni endpoints de autenticación.

## Aprovisionamiento seguro y reproducible

Fuente versionada: infra/keycloak/contract.mjs; solo configuración sin usuarios, contraseñas, tokens ni claves privadas. Keycloak genera sus claves y las persiste en PostgreSQL Identity. No se exportan realms con usuarios o secretos.

```powershell
pnpm install --frozen-lockfile
docker compose up -d --wait --wait-timeout 240
pnpm oidc:provision
pnpm oidc:check
```

Funciona tanto sobre un entorno limpio como sobre el PostgreSQL/Keycloak existente: obtiene un token administrativo temporal del realm master usando KEYCLOAK_ADMIN_USERNAME/PASSWORD del .env local (mínimo 16 caracteres), consulta innoview y crea el realm completo por Admin REST únicamente si falta. La autenticación password de admin-cli se utiliza solo para esta operación bootstrap local del IdP, nunca como flujo de las aplicaciones. Ese token y la contraseña no se imprimen ni se guardan en el repositorio, y no se entregan a Next.js/NestJS.

Si innoview existe, requiere su marca `innoview.managed-by=innoview-platform/oidc-v1` y verifica campos gestionados: flags del realm/clientes, PKCE, callbacks/logout/orígenes, scopes y mappers, ausencia de servicios de autorización/overrides de flujo/mappers directos inesperados. Omite IDs generados y metadatos internos del servidor. Repetir el comando sobre una configuración coincidente hace solo lecturas; no modifica usuarios, claves ni clientes.

Realm ajeno, cliente faltante o diferencia de configuración: salida no cero con nombres de campos; **no PUT, DELETE ni overwrite** desde el aprovisionador. No hay flag force ni import con override. Una modificación futura exige revisar el drift, respaldar y acordar una actualización explícita/auditada; no borrar volúmenes ni renombrar usuarios para resolverla. El comando check es de solo lectura y también verifica discovery/JWKS. Usa credenciales administrativas porque los parámetros privados de clientes no son parte del discovery público.

## Librerías y compatibilidad seleccionadas

| Librería      | Versión | Uso y evidencia                                                                                                                                                                                                                                                                                                   |
| ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openid-client | 6.8.8   | ESM/Fetch/WebCrypto, Node >=20. Discovery y Code + PKCE/validación de state/nonce, ID token firmado, refresh y logout probados con Node 24.22.1 y Keycloak 26.8.1. Seleccionada para Route Handlers Next.js 16 en runtime Node                                                                                    |
| jose          | 6.2.13  | ESM y WebCrypto; JWKS/JWS/JWT sin adaptador dependiente de Nest. Verificador de referencia probado con claves públicas de Keycloak y negativos criptográficos. Seleccionada para un provider/Guard NestJS 12 posterior                                                                                            |
| iron-session  | 9.0.1   | Seleccionada para sellar la cookie HttpOnly que contendrá solo un identificador opaco, no tokens. Node >=22.13, ESM y API documentada `getIronSession(await cookies(), options)`, compatible con cookies asíncronas de Next.js 16. No se instala hasta implementar sesiones, porque todavía no hay ese consumidor |

Las dos primeras se instalan como devDependencies raíz porque su consumidor actual son las herramientas y pruebas de contrato. Al integrar aplicaciones se declararán como dependencias de cada consumidor real. No se agregan Auth.js, Passport, Redis ni un SDK Keycloak específico. La compatibilidad de iron-session es documental por sus requisitos/API; su integración real con cookies permanece pendiente, no se presenta como probada.

## Flujos a integrar después — no implementados en 1.1

### Login y sesión local de cada aplicación

1. Un Route Handler Node recibe el inicio local de login. Si es POST, valida Origin y token CSRF ligado a la sesión/transacción; no aceptar redirects de retorno arbitrarios. Genera state, nonce y PKCE verifier independientes y aleatorios con openid-client. Mantiene esos datos solo en servidor, ligados a una transacción de un uso y al navegador, máximo 5 minutos.
2. Redirige al authorization endpoint con response_type=code, scope=openid, client_id correspondiente, callback exacto, state, nonce, code_challenge y método S256. No poner verifier ni tokens en URL.
3. Callback GET valida transacción, state, issuer de la respuesta y errores. Intercambia el code con el verifier desde servidor, sin una transacción PostgreSQL abierta durante HTTP. openid-client valida issuer/audiencia/nonce del ID token y se habilita enableNonRepudiationChecks para comprobar su firma. Consumir/inutilizar la transacción incluso ante errores; no reintentar ciegamente códigos ya intercambiados.
4. Regenera un SID aleatorio, guarda la sesión técnica servidor por aplicación/issuer/sub y entrega solo ese SID sellado por iron-session en cookie HttpOnly. Los tokens se almacenan del lado servidor, cifrados en reposo con una clave separada y nunca en localStorage, sessionStorage, cookies con tokens ni logs. Access y refresh tokens nunca se entregan al navegador; el ID token solo se transmite al IdP cuando se utiliza como id_token_hint en el logout estándar. El almacenamiento técnico de sesiones y su cifrado se implementarán después, con PostgreSQL existente; no se crean tablas en 1.1.
5. Next.js valida sesión y expiración en servidor y envía access token a la URL de API configurada mediante Authorization Bearer. Nunca proxy a un destino tomado del usuario. La autorización organizacional se consulta al Core cuando exista; no se guarda como autoridad un permiso declarado por el frontend.

Cookies distintas para Portal/Control Center, claves de sellado diferentes y sesiones particionadas por cliente. En desarrollo nombres `innoview.portal.sid` y `innoview.control.sid`, HttpOnly, SameSite=Lax, Path=/, sin Domain y Secure=false solo por HTTP local. Las cookies no se aíslan por puerto: ambos servidores pueden recibir cookies del mismo host, por lo que no deben aceptar ni poder descifrar las de la otra app. En HTTPS usar nombres __Host- específicos, Secure=true y host-only. Crear/modificar cookies en Route Handlers/Server Actions mediante await cookies(), no durante un render Server Component. No usar una cookie sellada como sustituto del registro de revocación servidor.

### Expiración, refresh y logout

- Access token: 300 segundos; authorization code: 60 segundos desde su emisión. Sesión SSO: idle 1800 segundos, máxima 28800. Sesión local no puede prolongar esas garantías: comprobar expiración, idle y revocación en servidor, y no superar 8 horas de duración absoluta.
- Refresh online y rotación en cada uso: revokeRefreshToken=true, maxReuse=0. Serializar renovaciones por sesión y coordinar instancias mediante control de concurrencia/leases; no mantener una transacción SQL durante la llamada al IdP. Una respuesta retrasada no debe sobrescribir una renovación posterior. Ante fallo definitivo de refresh, revocar sesión local y solicitar login; no reutilizar refresh tokens antiguos ni solicitar offline_access.
- Logout local: POST con validación Origin/CSRF, invalidar sesión servidor y cookie primero. Logout SSO: RP-initiated logout con id_token_hint del cliente, post_logout_redirect_uri fijo registrado y state de logout de un uso. Validar ese retorno sin reactivar la sesión. Nunca incluir access/refresh token en URLs. Preferir envío POST al endpoint de logout y omitir id_token_hint de logs, trazas y URLs registradas; las pruebas de contrato ejercitan también la variante GET admitida por el protocolo.
- La sesión SSO de Keycloak y las dos sesiones locales son diferentes. Logout local de Portal no garantiza logout de Control Center ni del IdP. Logout IdP no borra instantáneamente cookies de otras apps: sin backchannel implementado, detectar fallo de refresh y limitar la vigencia del access token. El handler backchannel y su prueba quedan pendientes de la integración de sesiones; 1.1 no promete revocación instantánea entre aplicaciones.

### Validación de access tokens en NestJS

El contrato ejecutable de referencia está en infra/keycloak/verify.mjs; todavía no es un Guard ni protege endpoints. El provider/Guard posterior usará jose con JWKS remoto derivado **solo** del issuer configurado, no de iss/jku/x5u recibidos del cliente. Cache de claves 10 minutos, timeout 5 segundos, cooldown 30 segundos para búsquedas de kid desconocido; fallo cerrado ante errores. Planificar rotación de claves y observabilidad sin aceptar otra autoridad por conveniencia.

Comprobar firma RS256 exclusivamente, issuer exacto, aud que contenga innoview-api, exp/iat/sub/azp requeridos, exp y nbf cuando exista, maxTokenAge de 5 minutos y tolerancia de reloj 5 segundos. Requerir typ=Bearer de Keycloak y azp de uno de los dos clientes conocidos. Rechazar ID tokens, tokens expirados, algoritmo distinto, firma/clave desconocida o audiencia de otro recurso. Devolver solo principal issuer/sub/clientId; email o claims de roles/tenant no son autorización Core. El ID token se valida en el BFF para su cliente, no como credencial de API.

## Verificaciones y límites de 1.1

```powershell
# Agregar TEST_KEYCLOAK_PORT=18081 y una contraseña aleatoria nueva
# TEST_KEYCLOAK_ADMIN_PASSWORD al .env existente si aún no están.
docker compose -f compose.test.yaml up -d --wait --wait-timeout 180
pnpm test
docker compose -f compose.test.yaml down
```

Las pruebas PostgreSQL existentes conservan su servidor independiente. Las pruebas OIDC usan Keycloak real 26.8.1 con dev-mem, sin volúmenes, administrador test_admin, contraseña aleatoria y puerto distinto del entorno normal. Esta base interna en memoria es solo un fixture efímero; desarrollo sigue usando exclusivamente PostgreSQL Identity. El test se niega a comenzar si ya hay un realm innoview o el puerto coincide con desarrollo. Los únicos usuarios y modificaciones destructivas son efímeros, creados por el test en ese servidor, y nunca se versionan.

Se verificaron creación desde master inicializado, repetición sin escrituras, preservación de master, discovery/issuer/JWKS, S256 obligatorio, redirects/grants inválidos, Code + PKCE real para ambos clientes con usuario sintético, firma/audiencia y rechazo de ID tokens, state incorrecto, rotación de refresh/rechazo de reutilización y RP logout con URI válida/inválida. Los negativos de issuer/audiencia/algoritmo/expiración/tipo usan claves sintéticas y están identificados como tales. El verificador acepta tokens reales de Keycloak, no solo fixtures.

En la instancia local se creó innoview sin usuarios reales (conteo cero), oidc:provision repetido y oidc:check pasaron, el issuer por hostname interno Docker conservó la URL canónica y los volúmenes previos permanecieron. Tras reiniciar Keycloak se compararon los IDs persistidos del realm y los tres clientes: conservaron sus valores y la verificación volvió a pasar. La ejecución local de pnpm test reportó 12 resultados PostgreSQL y 9 OIDC/JWT, cero fallos u omitidos (incluyen las pruebas principales que agrupan subpruebas). Lint, formato, tipos y los tres builds pasaron. La entrega identifica el commit y su run de Actions. El pipeline levanta PostgreSQL y Keycloak descartables con contraseñas generadas/enmascaradas, sin depender del IdP local.

Pendientes: integración efectiva Next.js/NestJS, claves/cookies/almacenamiento de sesiones, CSRF/backchannel en las aplicaciones, política de producción y revocación distribuida. No hay Tenant, Memberships, roles empresariales, UserIdentity local ni RLS. Próximo incremento recomendado para revisión: integración runtime de Identity y sesiones sobre este contrato, antes de exponer datos organizacionales. No iniciado.

## Fuentes oficiales consultadas

- https://www.keycloak.org/server/hostname — hostname público fijo y backchannel.
- https://www.keycloak.org/server/importExport — límites de imports sobre instancias existentes.
- https://www.keycloak.org/docs-api/26.8.1/rest-api/index.html — Admin REST y representaciones de realm/clientes/scopes.
- https://github.com/panva/openid-client/tree/v6.8.8 — requisitos ESM/Fetch/WebCrypto, PKCE, validación, refresh y logout.
- https://github.com/panva/jose — JWKS y jwtVerify.
- https://github.com/vvo/iron-session/tree/v9.0.1 — Node 22.13+, ESM y getIronSession con await cookies().
- https://nextjs.org/docs/app/api-reference/functions/cookies — API asíncrona y restricciones de escritura de cookies.
