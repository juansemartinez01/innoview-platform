# Foundation — acuerdos, monorepo, calidad e infraestructura (0.1–0.4)

Fecha de selección: 2026-10-24. No se cambia el stack acordado.

## Versiones fijadas

| Componente                        | Versión                   | Motivo                                                            |
| --------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| Node.js                           | 24.22.1                   | Única línea LTS para desarrollo y CI desde 0.3                    |
| pnpm                              | 11.25.0                   | Versión disponible en el equipo, fijada por packageManager        |
| Turborepo                         | 2.11.10                   | Orquestación de build, tipos y desarrollo                         |
| TypeScript                        | 6.0.3                     | Línea utilizada por NestJS 12; compilación verificada con Next.js |
| NestJS                            | 12.2.0                    | API modular; ESM con NodeNext                                     |
| Nest CLI                          | 12.0.10                   | Desarrollo con recompilación; build directo con tsc               |
| Next.js                           | 16.4.3                    | App Router, dos aplicaciones separadas                            |
| React / React DOM                 | 19.3.1                    | Peer dependencies compatibles con Next.js                         |
| RxJS / reflect-metadata           | 7.8.2 / 0.2.2             | Dependencias requeridas por NestJS                                |
| Tipos Node / React / React DOM    | 24.19.2 / 19.3.0 / 19.3.0 | Tipos de compilación                                              |
| ESLint / @eslint/js               | 10.13.0 / 10.0.1          | Línea mantenida de ESLint, configuración flat                     |
| typescript-eslint                 | 8.72.0                    | Compatible con TypeScript 6.0.3 y ESLint 10                       |
| eslint-config-next                | 16.4.3                    | Misma versión que Next.js                                         |
| Prettier / eslint-config-prettier | 3.9.10 / 10.1.8           | Formato separado del lint                                         |
| globals                           | 16.4.0                    | Globals de Node en API y configuración                            |

Dependencias directas exactas y resolución transitiva en pnpm-lock.yaml. Sin generadores que incorporen Tailwind, bibliotecas visuales, pruebas o paquetes sin uso. Los peers se verifican estrictamente al instalar.

TypeORM es el ORM aprobado; su versión, driver pg y compatibilidad con NestJS se fijan al incorporarlos en 0.5. Imágenes de infraestructura fijadas en 0.4: PostgreSQL 18.6-bookworm y Keycloak 26.8.1. Las librerías OIDC se eligen en Fase 1.

## Fuentes oficiales consultadas

- https://nodejs.org/en/about/previous-releases — líneas LTS.
- https://nextjs.org/docs/app/getting-started/installation — instalación manual, TypeScript y requisitos.
- https://docs.nestjs.com/first-steps y https://docs.nestjs.com/migration-guide — requisitos de NestJS 12, ESM y TypeScript 6.
- https://pnpm.io/installation — instalación y versiones; se conserva pnpm 11 instalado, sin actualizar herramientas globales.
- https://turborepo.dev/docs/reference/configuration — tareas, caché y desarrollo persistente.
- https://typeorm.io/docs/data-source/data-source-options/ — configuración de persistencia; ADR-024 determina migraciones y synchronize: false.
- Registro oficial npm: se consultaron versiones, engines y peerDependencies mediante npm view. Las versiones fijadas corresponden a publicaciones estables, sin etiquetas prerelease.

## Comandos e interfaces

- Raíz: pnpm install --frozen-lockfile, pnpm lint, pnpm format, pnpm format:check, pnpm typecheck, pnpm test, pnpm build, pnpm dev.
- Portal 3000, Control Center 3001, API 3002; loopback local. Sin variables secretas ni conexiones a servicios externos.
- API ESM con imports locales .js; TypeScript NodeNext preserva resolución válida del código compilado.
- Sin dependencias internas entre aplicaciones; contratos y paquetes aparecen cuando haya un consumidor concreto.
- Persistencia prevista: CLI de TypeORM, migraciones versionadas, SQL explícito para RLS, rol migrador separado y prueba reversible en base descartable. Se implementa en 0.5.

## Riesgos y próximos acuerdos

Los riesgos de autorización y aislamiento están en DECISIONS.md. La existencia del Control Center no concede privilegios ni representa una autorización implementada. No hay recursos tenant-owned todavía.

Repositorio publicado en GitHub y CI implementada con GitHub Actions en 0.3. Infraestructura local en 0.4. Pendientes: TypeORM/pg y roles en 0.5, librería de sesión/OIDC y bootstrap de organizaciones en Fase 1. No se configuran despliegues ni infraestructura facturable.

## Incremento 0.4 — infraestructura local

### Versiones y decisiones técnicas

- `postgres:18.6-bookworm` para ambos servidores independientes. PostgreSQL 18 está soportado por Keycloak; 18.6 es el parche estable consultado. Variante Debian explícita. Volúmenes montados en `/var/lib/postgresql`, ubicación requerida desde PostgreSQL 18 (PGDATA versionado por la imagen).
- `quay.io/keycloak/keycloak:26.8.1`, release estable oficial. `start-dev` y límite de memoria 1 GiB siguiendo instrucciones oficiales de desarrollo. No TLS, alta disponibilidad, hardening ni despliegues de producción.
- Dos redes bridge privadas del proyecto: Platform solo en `platform`; Identity y Keycloak en `identity`. No hay red compartida entre Keycloak y Platform. No se afirma aislamiento frente a un administrador Docker/host ni control de salida a Internet.
- Bases fijas distintas (`innoview_platform` y `keycloak`), propietarios bootstrap distintos y contraseñas requeridas mediante `.env`. Keycloak tiene JDBC fijo a `postgres-identity:5432/keycloak` y solo recibe la contraseña de Identity, nunca la de Platform.
- Estos propietarios bootstrap tienen privilegios administrativos locales por la inicialización de la imagen PostgreSQL. Ninguna aplicación los utiliza. Los roles de aplicación restringidos y separación migrador/app de ADR-021/024 se implementan en 0.5; no se simula seguridad RLS en 0.4.
- Publicaciones al host: Platform en 127.0.0.1:55432 y Keycloak en 127.0.0.1:8080, puertos configurables. Identity y gestión Keycloak 9000 no se publican. Proyecto Compose `innoview-platform-dev`, sin container_name fijo ni volúmenes externos, para no reutilizar datos ajenos.
- Dos volúmenes persistentes independientes para PostgreSQL. Los datos de Keycloak residen en Identity; su contenedor es reemplazable y no requiere volumen adicional. No se importan realms ni se crean clientes OIDC.
- PostgreSQL usa pg_isready TCP al loopback interno; comprobaciones SQL adicionales verifican base y usuario. Keycloak espera `service_healthy` de Identity y consulta `/health/ready` con bash/TCP, sin instalar curl. HEALTH y METRICS activados para incluir comprobación de conexión a BD. `up --wait` espera salud de los tres servicios.
- `.env.example` versionado sin contraseñas funcionales. `.env` ignorado, generado localmente para las verificaciones con valores aleatorios independientes. No imprimir configuración interpolada ni hacer commits de credenciales.
- Comandos completos de creación de .env, arranque, salud, reinicio, stop/down y recuperación sin eliminar volúmenes en README.md. No se cambia el código de las aplicaciones ni las ADR.

### Fuentes oficiales de 0.4

- https://www.postgresql.org/support/versioning/ — versión 18 y parche 18.6.
- https://hub.docker.com/_/postgres — tag bookworm, inicialización y ubicación de volumen PostgreSQL 18.
- https://github.com/keycloak/keycloak/releases/tag/26.8.1 — release oficial.
- https://www.keycloak.org/server/db — compatibilidad PostgreSQL 18 y JDBC.
- https://www.keycloak.org/server/containers — start-dev, bootstrap y límite de memoria.
- https://www.keycloak.org/observability/health — disponibilidad y comprobación de la base.
- https://docs.docker.com/compose/how-tos/startup-order/ — depends_on/service_healthy.

### Verificaciones de 0.4 — 2026-10-24

- Docker Desktop 4.40.0, Engine 28.0.4, Compose 2.34.0, contenedores Linux/amd64, comandos desde PowerShell en Windows.
- `docker compose config --quiet`: satisfactorio antes y después de formatear YAML. Configuración con exactamente tres servicios, JDBC fijo a Identity y redes sin intersección entre Keycloak y Platform.
- `docker compose up -d --wait --wait-timeout 240`: los tres servicios healthy. Ambos PostgreSQL ejecutan versión 18.6; SQL autenticado por TCP confirmó bases y usuarios separados.
- Keycloak `/health/ready` devolvió HTTP 200, status UP y `Keycloak database connections async health check: UP`. Discovery del realm master en 127.0.0.1:8080 devolvió 200.
- pg_stat_activity de Identity mostró las conexiones del IP del contenedor Keycloak con usuario identity_local_owner a base keycloak. Platform no tuvo conexiones de Keycloak y conservó cero tablas públicas.
- Persistencia verificada después de `restart` y después de `down` + `up`, sin opciones de eliminación de volúmenes: marca temporal en comentario de la base Platform e ID de realm master en Identity se conservaron. La marca se retiró restaurando el comentario vacío; no se crearon tablas de prueba ni entidades. No se tocaron volúmenes o contenedores ajenos.
- Puertos publicados: únicamente 127.0.0.1:55432 y 127.0.0.1:8080. Identity y 9000 sin publicación al host. Los dos volúmenes persisten y el entorno queda levantado para revisión.
- `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`: satisfactorios. No se cambian dependencias, lockfile ni código de las aplicaciones.
- Credenciales aleatorias locales solamente en .env ignorado. .env.example sin passwords funcionales. Revisión de archivos versionados y comprobación de secretos antes de commit.
- Advertencias de Keycloak: modo dev, features/opciones internas deprecadas y aviso de uso de OpenTelemetry del upstream. No impidieron arranque ni healthchecks. Un HTTP consultado antes de finalizar el primer arranque falló transitoriamente; después de --wait devolvió 200, también tras recreación. No se habilitan features extra para silenciar avisos.
- Digests observados al descargar (tags fijados en Compose): PostgreSQL sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc; Keycloak sha256:a78d6b79572168cb25886b80a8b5b8d4ed4390743e3eecb810538683e209dd6b.
- Pendiente de revisión: 0.4. No se implementa TypeORM, migraciones de Platform, autenticación de las aplicaciones, RBAC ni RLS. No se avanza a 0.5.

## Incremento 0.3 — política de calidad

- Node 24.22.1 fijado en `.node-version` y `devEngines.runtime`; pnpm administra el runtime local, sin cambios globales. CI lee `.node-version`. Actualizar ambos archivos juntos al actualizar Node, comprobar `pnpm exec node --version` y regenerar lockfile. Tipos Node actualizados a la misma versión principal.
- Configuración ESLint única en raíz: API con recommendedTypeChecked y projectService; Next.js con Core Web Vitals y TypeScript; configuraciones JavaScript con reglas recomendadas. `--max-warnings=0` hace fallar el control ante advertencias. TypeScript comparte strict y mantiene NodeNext en API/bundler en Next.js.
- ESLint 9 se descartó al verificar que llegó a EOL. Next.js 16.4 declara soporte para ESLint 10, pero react, jsx-a11y e import aún declaran peers <=9. Se agregaron exclusivamente tres excepciones `plugin>eslint: 10` en peerDependencyRules, sin desactivar strictPeerDependencies ni modificar plugins o reglas. Revisarlas al actualizar dependencias y retirarlas cuando los paquetes amplíen sus rangos. Lint real sobre las tres aplicaciones debe pasar antes de publicar.
- unrs-resolver usa los binarios opcionales distribuidos para cada plataforma. Se declara `allowBuilds.unrs-resolver: false` para no ejecutar su postinstall de descarga alternativa. La resolución de imports se verifica con lint local y CI; no se habilitan scripts de instalación globalmente.
- Prettier aplica comillas simples, trailing commas y LF. Ignora el lockfile, next-env.d.ts y bloques AGENTS.md regenerados por Next.js, además de los patrones de .gitignore. Reformatear documentos no cambia decisiones arquitectónicas.
- .gitignore cubre dependencias, compilados, cachés, cobertura, logs, .env y claves/certificados privados habituales. Los ejemplos .env.example pueden versionarse solo con valores ficticios. El ignore no sustituye revisión antes de cada commit.
- CI: push, pull_request y workflow_dispatch en Ubuntu; permisos contents: read, sin credenciales persistidas por checkout, timeout y cancelación de runs anteriores. Acciones checkout v7, setup-node v7 y pnpm/action-setup v6 fijadas por SHA. No hay caché remota ni despliegues.
- Pipeline: instalación congelada → lint → formato → tipos → scripts de tests existentes → build. `pnpm test` usa `pnpm -r --if-present test`: no hay suites ni cobertura actualmente. La primera suite real se integra con su script test no interactivo; no se usa passWithNoTests ni tests ficticios.
- Estado de cada commit: [GitHub Actions](https://github.com/juansemartinez01/innoview-platform/actions/workflows/ci.yml). La aceptación completa de Fase 0 continúa pendiente de 0.4–0.6.

### Validación local de 0.3 — 2026-10-24

- `pnpm install --frozen-lockfile`: satisfactorio con peers estrictos y allowBuilds explícito.
- `pnpm exec node --version`: v24.22.1; ya no se ejecutan las aplicaciones con Node 22.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck` y `pnpm build`: satisfactorios en las tres aplicaciones.
- `pnpm test`: satisfactorio sin suites existentes; no representa cobertura.
- Verificación temporal en memoria: no-floating-promises, react/jsx-key y la regla Next no-img-element detectaron los problemas introducidos en snippets, sin modificar el código ni crear suites ficticias.
- Smoke de los tres procesos compilados con Node 24.22.1: HTTP 200 y contenido esperado. Procesos cerrados y script temporal retirado.
- next-env.d.ts retirado del seguimiento Git y añadido al ignore; Next.js lo genera en typegen/dev/build. Se comprobaron ignores de .env, claves, dependencias y artefactos; revisión de secretos y git diff --check antes de publicar.
- CI remota se verifica tras publicar el commit; la ejecución asociada se informa en la entrega. No se avanza a 0.4.

### Referencias

- https://nextjs.org/docs/app/api-reference/config/eslint y guía instalada en node_modules/next/dist/docs: flat config, ESLint 10 y compatibilidad de plugins.
- https://eslint.org/version-support/ — ESLint 9 EOL; ESLint 10 mantenido.
- https://typescript-eslint.io/getting-started/ — configuración recomendada.
- https://prettier.io/docs/install — versión exacta y comandos de formato/verificación.
- https://pnpm.io/settings/cli — engineStrict y runtime; devEngines.runtime para pnpm 11.
- https://github.com/actions/setup-node y https://github.com/pnpm/action-setup — configuración de acciones oficiales. SHAs verificados con git ls-remote.

## Verificación realizada — 2026-10-24

Este apartado conserva evidencia histórica de 0.1/0.2; la política vigente de Node y CI es la de 0.3, descrita arriba.

- `git init -b main`: repositorio local inicializado, sin remoto ni commits.
- `pnpm install`: cuatro proyectos workspace (raíz y tres aplicaciones); instalación con peers estrictos satisfactoria.
- `pnpm install --frozen-lockfile`: satisfactorio, sin cambios en resolución.
- `pnpm typecheck`: tres tareas satisfactorias, incluyendo generación de tipos de rutas Next.js.
- `pnpm build`: tres tareas satisfactorias; ambas páginas Next.js prerenderizadas y API compilada.
- Smoke temporal con procesos reales: API 3002, portal 3000 y Control Center 3001 devolvieron HTTP 200 y contenido esperado. Se repitió en modo desarrollo (Next dev y Nest start --watch) satisfactoriamente. Se cerraron los árboles de procesos iniciados y se retiró el script temporal.
- Entorno observado: Node ejecutado directamente y por las apps 22.15.0; wrapper pnpm 11.25.0 utiliza Node 24.22.1. El rango inicial limitado a 22 produjo una advertencia, corregida admitiendo ambas líneas LTS compatibles; instalación congelada posterior sin advertencia.
- La automatización rechazó una primera invocación extensa de shell antes de ejecutarla; se completó mediante ediciones de archivos y comandos acotados. No quedó trabajo bloqueado.
- Sin tests de negocio ni integración PostgreSQL: todavía no hay reglas ni persistencia. Lint, formato y CI pendientes de 0.3; la Fase 0 completa no está terminada.
- `git diff --check`: satisfactorio. Puertos 3000/3001/3002 sin listeners después del smoke. Next.js generó AGENTS.md en ambas aplicaciones durante next dev; se conservan sus instrucciones locales y no sustituyen AGENTS.md de la raíz.
