# Foundation — acuerdos, monorepo y calidad (0.1–0.3)

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

TypeORM es el ORM aprobado; su versión, driver pg y compatibilidad con NestJS se fijan al incorporarlos en 0.5. PostgreSQL y Keycloak tendrán versiones exactas verificadas en 0.4; no se descargan imágenes ni se eligen librerías OIDC antes de necesitarlas. No bloquean 0.2.

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

Repositorio publicado en GitHub y CI implementada con GitHub Actions en 0.3. Pendientes: versiones Docker/PostgreSQL/Keycloak en 0.4, TypeORM/pg y roles en 0.5, librería de sesión/OIDC y bootstrap en Fase 1. No se configuran despliegues ni infraestructura facturable.

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
