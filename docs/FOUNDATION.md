# Acuerdos mínimos — 0.1 y monorepo — 0.2

Fecha de selección: 2026-10-24. No se cambia el stack acordado.

## Versiones fijadas

| Componente | Versión | Motivo |
|---|---|---|
| Node.js | 22 >=22.15 o 24 >=24.11 | Líneas LTS compatibles; usar último parche disponible |
| pnpm | 11.25.0 | Versión disponible en el equipo, fijada por packageManager |
| Turborepo | 2.11.10 | Orquestación de build, tipos y desarrollo |
| TypeScript | 6.0.3 | Línea utilizada por NestJS 12; compilación verificada con Next.js |
| NestJS | 12.2.0 | API modular; ESM con NodeNext |
| Nest CLI | 12.0.10 | Desarrollo con recompilación; build directo con tsc |
| Next.js | 16.4.3 | App Router, dos aplicaciones separadas |
| React / React DOM | 19.3.1 | Peer dependencies compatibles con Next.js |
| RxJS / reflect-metadata | 7.8.2 / 0.2.2 | Dependencias requeridas por NestJS |
| Tipos Node / React / React DOM | 22.20.5 / 19.3.0 / 19.3.0 | Tipos de compilación |

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

- Raíz: pnpm install --frozen-lockfile, pnpm typecheck, pnpm build, pnpm dev.
- Portal 3000, Control Center 3001, API 3002; loopback local. Sin variables secretas ni conexiones a servicios externos.
- API ESM con imports locales .js; TypeScript NodeNext preserva resolución válida del código compilado.
- Sin dependencias internas entre aplicaciones; contratos y paquetes aparecen cuando haya un consumidor concreto.
- Persistencia prevista: CLI de TypeORM, migraciones versionadas, SQL explícito para RLS, rol migrador separado y prueba reversible en base descartable. Se implementa en 0.5.

## Riesgos y próximos acuerdos

Los riesgos de autorización y aislamiento están en DECISIONS.md. La existencia del Control Center no concede privilegios ni representa una autorización implementada. No hay recursos tenant-owned todavía.

Pendientes antes de los incrementos correspondientes: proveedor de CI en 0.3 (propuesta GitHub Actions, sin remoto creado), versiones Docker/PostgreSQL/Keycloak en 0.4, TypeORM/pg y roles en 0.5, librería de sesión/OIDC y bootstrap en Fase 1. No se configuran despliegues ni infraestructura facturable.

## Verificación realizada — 2026-10-24

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
