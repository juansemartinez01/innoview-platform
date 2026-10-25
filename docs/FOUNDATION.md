# Foundation — cierre técnico de Fase 0 (0.1–0.6)

Fecha de selección: 2026-10-24. No se cambia el stack acordado.

## Estado de cierre — 2026-10-25

Criterios técnicos verificados y Fase 0 oficialmente cerrada por el usuario tras revisar c069a9a y Actions. Este cierre cubre herramientas, infraestructura local y persistencia técnica. Fase 1 autorizada solo para el contrato/configuración 1.1 descrito en OIDC.md (ADR-025/026); no hay login de aplicaciones, entidades empresariales ni RLS.

| Incremento                   | Estado y evidencia                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| 0.1 — Acuerdos mínimos       | Aprobado. Tenant/Deployment, TypeORM y riesgos documentados; ADR-023/024                   |
| 0.2 — Monorepo               | Aprobado. pnpm/Turbo y tres aplicaciones; commit inicial 764d9b3                           |
| 0.3 — Calidad y CI           | Aprobado. Node 24, ESLint/Prettier y Actions; commit 955ff64                               |
| 0.4 — Infraestructura Docker | Aprobado. PostgreSQL Platform/Identity y Keycloak separados; commit ad5dee9                |
| 0.5 — Persistencia           | Aprobado. Roles, DataSource separados, migración técnica y PostgreSQL real; commit eee7307 |
| 0.6 — Verificación y cierre  | Aprobado por el usuario; Fase 0 oficialmente cerrada en c069a9a                            |

### Recorrido integral desde clon limpio

Se clonó desde GitHub el commit eee7307 en un directorio temporal sin .env, node_modules ni artefactos. Se usaron contraseñas nuevas, proyectos Compose innoview-foundation-close/innoview-foundation-close-test y puertos 55434/55435/18080 para evitar los volúmenes y credenciales del proyecto habitual. Git/Docker/pnpm ya estaban instalados y el store pnpm tenía caché; esto verifica un clon limpio, no una reinstalación del sistema operativo.

| Comprobación                                 | Resultado                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instalación congelada del clon               | Correcta; runtime Node 24.22.1, sin modificar lockfile                                                                                                        |
| Compose y tres servicios nuevos              | Configuración válida, PostgreSQL Platform/Identity y Keycloak healthy                                                                                         |
| Aprovisionamiento en base nueva y repetición | Correcto, sin borrado de datos                                                                                                                                |
| Migraciones                                  | show pendiente → run aplicado → show [X]; repetir run no encontró pendientes                                                                                  |
| Generación y creación                        | generate --check sin diferencias; create produjo un archivo técnico temporal fuera del directorio activo de migraciones, sin aplicarlo                        |
| pnpm dev desde raíz                          | Tres aplicaciones HTTP 200, incluyendo inicio correcto de NestJS por Turborepo                                                                                |
| Build y ejecución compilada                  | Tres builds correctos y tres aplicaciones HTTP 200                                                                                                            |
| API sin credenciales administrativas         | Ambos modos arrancaron con .env reducido a DB_HOST/PORT/NAME/SSL/APP_USER/APP_PASSWORD; no necesitó bootstrap, migrador ni Keycloak                           |
| Identidad de conexión                        | Consulta con las credenciales runtime confirmó current_user=innoview_app; NestJS usa el mismo provider validado                                               |
| Roles/errores negativos                      | API rechazó contraseña incorrecta y rol bootstrap; CLI rechazó rol bootstrap y revert sobre desarrollo, todos con salida no cero                              |
| Contraseñas en logs                          | No aparecieron en logs capturados de arranque normal ni errores negativos; no se imprime configuración interpolada                                            |
| Persistencia tras restart                    | Dato técnico en Platform, historial migrador e ID realm master conservaron sus valores; Keycloak volvió a HTTP 200. Dato técnico de comprobación retirado     |
| Pruebas reales                               | 11 subpruebas más prueba principal: 12 resultados satisfactorios, cero fallos/omitidos; base/roles únicos creados y eliminados dentro del PostgreSQL temporal |
| Calidad                                      | lint, format:check, typecheck y build satisfactorios; sin suites ficticias                                                                                    |
| Limpieza                                     | Procesos de comprobación detenidos; proyectos de comprobación detenidos sin eliminar volúmenes. Servicios habituales preservados                              |

La evidencia de CI final corresponde al commit de cierre publicado: [workflow CI](https://github.com/juansemartinez01/innoview-platform/actions/workflows/ci.yml). La entrega incluye el enlace inmutable al run verificado. Las pruebas automáticas de CI usan su PostgreSQL temporal; la comprobación conjunta de las tres aplicaciones y Keycloak se realizó localmente en Windows.

### Problemas encontrados y correcciones de cierre

- README tenía comandos correctos pero dispersos y sin un recorrido completo para una computadora nueva. Se agregaron requisitos, enlaces oficiales, clone/install, generación de .env que falla si ya existe, orden de servicios/roles/migraciones, pruebas y comprobaciones HTTP.
- Faltaban instrucciones explícitas para dos clones en el mismo equipo. Se documentaron proyectos Compose y puertos distintos, evitando reutilizar volúmenes con contraseñas nuevas. No se eliminaron volúmenes para resolver conflictos.
- La documentación conservaba frases históricas de etapas previas que podían interpretarse como estado vigente. Se distingue el cierre actual de la evidencia histórica y se actualiza IMPLEMENTATION_PLAN.
- No se encontraron problemas críticos de configuración que requieran cambiar dependencias, código de aplicaciones, seguridad de roles o decisiones arquitectónicas en 0.6. No se modifica DECISIONS.md.

### Riesgos y trabajo abierto

- OIDC de aplicaciones, entidades empresariales, membresías, RBAC y RLS no están implementados. No exponer datos de clientes hasta que existan sus controles backend y pruebas correspondientes; la respuesta actual de API es técnica.
- Las pruebas de privilegios técnicos no acreditan aislamiento multi-tenant, contexto transaccional ni UoW. Estas verificaciones se incorporarán al implementar esos mecanismos.
- Local usa HTTP/start-dev y propietarios bootstrap administrativos. No es configuración de producción; faltan TLS, políticas de conexión, gestión/rotación de secretos, backups, observabilidad operativa y decisiones de hosting/HA.
- Las ACL se administran en Platform, no en otras bases del clúster; producción requiere restringir también conexiones y provisión. El historial está protegido de app, pero el migrador puede modificar sus objetos: acceso y revisión de SQL siguen siendo controles necesarios.
- Revert tiene guardas de nombre/entorno y validación del migrador; no reemplaza una autorización de producción ni convierte una base con datos en descartable. Las pruebas solo revierten bases que ellas mismas acaban de crear.
- Nuevos esquemas de Core requieren extender explícitamente permisos, registro de entidades/migraciones y validación de propietario del migrador. No relajar esas comprobaciones para hacer funcionar una migración futura.
- Mantener bajo revisión las excepciones acotadas de peers ESLint 10 y las versiones fijadas. Los avisos de desarrollo/deprecación del upstream Keycloak no impiden su salud y no se silencian habilitando features extra.

No quedan bloqueos críticos para comenzar a diseñar Platform Core, dentro de estos límites. El análisis de dependencias y el siguiente incremento propuesto están en [PHASE_1_PREPARATION.md](PHASE_1_PREPARATION.md); no hay implementación de Fase 1.

### Estructura al cierre

```text
innoview-platform/
├── .github/workflows/ci.yml
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── main.ts, app.module.ts, app.controller.ts
│   │   │   └── persistence/
│   │   │       ├── connection.config.ts, data-sources.ts
│   │   │       ├── migration-data-source.ts, migration.cli.ts
│   │   │       ├── persistence.module.ts, persistence.spec.ts
│   │   │       ├── provision.ts, provision.cli.ts
│   │   │       └── migrations/1792886400000-FoundationProbe.ts
│   │   ├── package.json, nest-cli.json
│   │   └── tsconfig.json, tsconfig.build.json, tsconfig.test.json
│   ├── portal/
│   │   ├── app/layout.tsx, app/page.tsx
│   │   └── AGENTS.md, package.json, tsconfig.json
│   └── control-center/
│       ├── app/layout.tsx, app/page.tsx
│       └── AGENTS.md, package.json, tsconfig.json
├── docs/
│   ├── PRODUCT.md, ARCHITECTURE.md, DATA_MODEL.md, DECISIONS.md
│   ├── FOUNDATION.md, IMPLEMENTATION_PLAN.md
│   └── PHASE_1_PREPARATION.md
├── compose.yaml, compose.test.yaml
├── .env.example, .gitignore, .gitattributes, .node-version
├── .prettierrc.json, .prettierignore, eslint.config.mjs
├── package.json, pnpm-lock.yaml, pnpm-workspace.yaml
├── tsconfig.base.json, turbo.json
└── AGENTS.md, README.md
```

Sin paquetes compartidos vacíos ni worker implementado. .env, node_modules, dist, dist-test, .next, next-env.d.ts y cachés son locales/ignorados. La estructura anterior agrupa nombres de archivos para lectura; las carpetas futuras de arquitectura todavía no existen.

## Referencia e historial de incrementos

Las secciones siguientes conservan decisiones técnicas y evidencia de cada incremento. Las frases de alcance fechadas describen el estado en ese momento; el estado vigente es el cierre anterior.

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

Persistencia en 0.5: TypeORM 1.1.2, pg 8.23.1 y @types/pg 8.23.1, versiones exactas. Compilación y conexión verificadas con NestJS 12.2.0, TypeScript 6.0.3, Node 24.22.1 y PostgreSQL 18.6. Integración mediante provider asíncrono de DataSource y cierre con el ciclo de vida NestJS; no hace falta agregar @nestjs/typeorm mientras no haya consumidores de repositorios. Imágenes de infraestructura fijadas en 0.4: PostgreSQL 18.6-bookworm y Keycloak 26.8.1. Las librerías OIDC se eligen en Fase 1.

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
- Portal 3000, Control Center 3001, API 3002; loopback local. Desde 0.5 la API se conecta al PostgreSQL local con credenciales inyectadas, sin secretos versionados.
- API ESM con imports locales .js; TypeScript NodeNext preserva resolución válida del código compilado.
- Sin dependencias internas entre aplicaciones; contratos y paquetes aparecen cuando haya un consumidor concreto.
- Persistencia: CLI de TypeORM, migraciones versionadas y rol migrador separado implementados en 0.5. SQL de políticas RLS y contexto tenant siguen pendientes de fases posteriores.

## Riesgos y próximos acuerdos

Los riesgos de autorización y aislamiento están en DECISIONS.md. La existencia del Control Center no concede privilegios ni representa una autorización implementada. No hay recursos tenant-owned todavía.

Repositorio publicado en GitHub, CI en 0.3, infraestructura local en 0.4, persistencia en 0.5 y verificación integral en 0.6. Pendientes: revisión del cierre, librería de sesión/OIDC y bootstrap de organizaciones en Fase 1. No se configuran despliegues ni infraestructura facturable.

## Incremento 0.5 — persistencia técnica y privilegios

### Configuración y límites

Infraestructura en apps/api/src/persistence, separada de reglas de negocio. Sin entidades empresariales, decorators ORM, paquetes vacíos, framework UoW ni políticas RLS. Los futuros módulos tendrán sus esquemas y directorios propios de migraciones; no se otorgan permisos a esquemas hipotéticos. DataSource/EntityManager de TypeORM permiten transacciones futuras sin implementar todavía contexto tenant ni UoW.

- connection.config.ts valida host, puerto, nombre de base/usuarios, contraseña requerida (mínimo 16) y TLS explícito disable/require. Los errores nombran campos, nunca valores. TLS require mantiene rejectUnauthorized: true. No hay fallback a credenciales administrativas para app/migraciones.
- data-sources.ts crea conexiones separadas para app y migrador, con synchronize: false, migrationsRun: false, sin dropSchema, entidades vacías y logging deshabilitado. El CLI TypeORM activa sus logs normales de migraciones, que no contienen credenciales de aprovisionamiento.
- API: schema foundation, sin migraciones cargadas, validación al conectar de flags, membresías, propiedad y DDL/TEMP. Falla antes de escuchar si el rol no cumple. Provider asíncrono NestJS y cierre del pool al apagar. No se configura un backend de producción ni se imprime la configuración.
- Migrador: schema platform_meta, tabla migrations y glob de migraciones JavaScript relativas al módulo ESM, independiente del directorio de ejecución. El wrapper comprueba conexión, flags, membresías y propiedad de los esquemas antes de operar, para no ejecutar el CLI accidentalmente como bootstrap. Compila antes de ejecutar; create/generate producen TypeScript para revisión. No hay entidades para generar diferencias todavía.
- Bootstrap solo en provision.cli.ts; reutiliza PLATFORM_POSTGRES_PASSWORD existente. Provisionamiento explícito, no initdb ni arranque automático de API. Cambios versionados en código de aprovisionamiento, sin scripts SQL manuales sobre tablas de negocio.

### Política de privilegios efectiva en Platform

| Identidad local      | Privilegios                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| platform_local_admin | Administrador bootstrap y propietario de la base existente; no usado por API/CLI de migraciones                                                                                                   |
| innoview_migrator    | LOGIN, propietario exclusivamente de foundation/platform_meta y sus objetos administrados; CONNECT a Platform; sin SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION, sin membresías, NOINHERIT |
| innoview_app         | LOGIN y CONNECT; USAGE foundation; CRUD de tablas; USAGE de secuencias; sin propiedad, DDL, TEMP, TRUNCATE, SET ROLE migrador ni acceso a platform_meta                                           |

Se revocan permisos PUBLIC en la base administrada y schema public. No se cambia la propiedad de la base ni se toca Identity. No se alteran ACL de otras bases del clúster: en producción se necesitarán además políticas de conexión y credenciales limitadas al despliegue.

Los defaults del migrador en foundation conceden únicamente SELECT/INSERT/UPDATE/DELETE y USAGE de secuencias a app. Se revocan grants previos/defaults para PUBLIC/app antes de reconciliar, y EXECUTE de funciones actuales/futuras permanece denegado. platform_meta no concede USAGE a app ni privilegios sobre tablas/secuencias. Así el historial no queda escribible por aplicación. Objetos creados por otros propietarios se rechazan, no se reasignan silenciosamente.

Provisionamiento en transacción con lock asesor: crea roles con marcador de propiedad; rechaza roles ajenos, membresías inesperadas, propiedad de app o migrador propietario de bases y esquemas/objetos con propietario inesperado. Al repetirlo reconcilia ACL y contraseñas sin borrar datos. Contraseñas citadas mediante pg.escapeLiteral e identificadores validados/citados; los errores PostgreSQL de este procedimiento no se imprimen porque pueden contener SQL sensible. No se registra el valor de contraseñas.

### Operación y pruebas

Comandos desde raíz: pnpm db:provision, db:show, db:run, db:create y db:generate. Las rutas para create/generate son relativas a apps/api. Documentación ejecutable y preparación de .env en README.md. Mantener credenciales bootstrap/migrador fuera del entorno de API en despliegues futuros; el .env conjunto es conveniencia solo local.

Revert restringido por el wrapper a DB_DISPOSABLE=true y nombre innoview_test_ seguido de 32 hexadecimales. No es una autorización de producción: nunca apuntarlo a datos existentes. La suite genera su propio nombre, crea la base, ejecuta CLI revert/run y la elimina junto con roles generados. No lee DB_NAME de desarrollo como destino de borrado. No hay reversión sobre el volumen local.

compose.test.yaml crea un PostgreSQL 18.6 independiente, puerto loopback 55433, sin volúmenes y con tmpfs. Node test runner (sin Jest/Testcontainers ni librerías extra) usa TEST_*; requiere el servicio real y falla si falta configuración. En Actions se genera contraseña aleatoria, se enmascara, se arranca el mismo Compose temporal y se detiene con always(). No se modifica Compose de desarrollo ni se borran sus volúmenes.

Las pruebas cubren conexión, credenciales inválidas, flags y membresías, propiedad, migración aplicada por migrador, CRUD y secuencias, DDL/TEMP/TRUNCATE/SET ROLE/metadata denegados, defaults de objetos futuros, repetición sin pérdida de datos, validación del rol de API y reversión/reaplicación por CLI. **No son pruebas de aislamiento multi-tenant/RLS.**

### Validación de 0.5 — 2026-10-25

- Versiones publicadas y engines/peers consultados; pnpm install --frozen-lockfile sin conflictos. Sin actualización de imágenes, Node, NestJS ni TypeScript.
- Pruebas reales con PostgreSQL 18.6 temporal: 12 resultados exitosos del runner (contenedor principal y 11 subpruebas), cero fallos y cero omitidos. Ejecución de migraciones por migrador, CRUD por app, rechazo de permisos extra, idempotencia antes/después de crear objetos y reversión/reaplicación a través del CLI.
- En el volumen local existente: db:provision ejecutado repetidamente; db:show pasó de pendiente a aplicada; db:run aplicó la migración y al repetirlo no encontró pendientes. No se borraron/recrearon volúmenes de desarrollo ni se revirtió su migración.
- db:revert rechazó la base de desarrollo con código 1, sin ejecutar cambios. db:create/db:generate --help disponibles; db:generate con --check devolvió 0 y ninguna diferencia (sin entidades todavía).
- SQL local confirmó SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE/REPLICATION falsos para ambos roles y tablas foundation.persistence_probe/platform_meta.migrations propiedad de innoview_migrator.
- API NestJS compilada arrancó con PersistenceModule y respondió HTTP 200; se cerró el proceso de comprobación. La suite verifica además el rechazo de roles incorrectos para API y CLI.
- lint, formato, tipos, tests y build se ejecutan antes de publicar; el estado remoto de Actions asociado al commit se informa en la entrega. PostgreSQL temporal se detiene sin tocar el proyecto Compose de desarrollo.
- Sin credenciales reales versionadas. Las nuevas contraseñas locales se agregan al .env ignorado, conservando las anteriores. No se avanza a 0.6; todavía no se valida aislamiento multi-tenant.

### Referencias de persistencia

- https://typeorm.io/docs/data-source/data-source-options/ y https://typeorm.io/docs/migrations/setup/ — opciones y CLI. Engines/peers verificados mediante pnpm view typeorm/pg.
- https://docs.nestjs.com/fundamentals/custom-providers — provider asíncrono para DataSource.
- https://node-postgres.com/features/connecting — conexión PostgreSQL explícita.
- https://www.postgresql.org/docs/18/sql-grant.html y https://www.postgresql.org/docs/18/sql-alterdefaultprivileges.html — permisos actuales y futuros por propietario/esquema.
- https://nodejs.org/docs/latest-v24.x/api/test.html — runner nativo y subpruebas.

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
- Pipeline original de 0.3: instalación congelada → lint → formato → tipos → scripts de tests existentes → build. Al cerrar 0.3 no había suites; desde 0.5 `pnpm test` ejecuta integración real con PostgreSQL temporal. No se usa passWithNoTests ni tests ficticios.
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
