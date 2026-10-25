# Innoview Platform

Foundation MVP, incrementos 0.1 a 0.3. Fuente de verdad: AGENTS.md y docs/.

## Requisitos

Node.js 24 LTS, fijado en **24.22.1** para desarrollo y CI, y pnpm **11.25.0**. `.node-version` configura GitHub Actions y gestores de versiones compatibles; `devEngines.runtime` permite a pnpm descargar y utilizar esa versión para los comandos del proyecto, sin cambiar la instalación global. `engines` y `engineStrict` restringen la compatibilidad a Node 24. `pnpm exec node --version` debe devolver `v24.22.1`. Node 22 ya no es el entorno de desarrollo admitido.

## Comandos desde la raíz

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm dev
```

Desarrollo: portal http://127.0.0.1:3000, Control Center http://127.0.0.1:3001 y API http://127.0.0.1:3002. Detener con Ctrl+C.

Después del build, ejecutar cada aplicación por separado con `pnpm --filter @innoview/portal start`, `pnpm --filter @innoview/control-center start` y `pnpm --filter @innoview/api start`.

Las páginas y la respuesta raíz de la API solo comprueban arranque. No hay acceso a datos, autenticación ni administración todavía. Los servidores escuchan únicamente en loopback. No son una configuración de producción.

## Límites actuales

Sin paquetes compartidos vacíos, módulos comerciales, worker, Docker ni persistencia. TypeORM está aprobado, pero se incorpora junto con migraciones en 0.5. Keycloak/OIDC se integra en Fase 1, después del entorno local de 0.4.

## Calidad y CI

`pnpm lint` utiliza ESLint flat config: reglas TypeScript con información de tipos para NestJS y Core Web Vitals/TypeScript para ambas aplicaciones Next.js. No se admiten advertencias. TypeScript conserva `strict` en la base y las diferencias necesarias de resolución NodeNext/bundler en cada aplicación.

`pnpm format` aplica Prettier y `pnpm format:check` verifica formato sin escribir. Se excluyen artefactos, lockfile y archivos que Next.js regenera. Los cambios en documentos existentes son de formato, sin alterar las ADR.

`pnpm test` ejecuta los scripts `test` que existan en los workspaces. Actualmente no hay suites: esto no acredita pruebas ni cobertura. Al agregar la primera suite real, definir su script `test` sin watch; se incorporará al pipeline automáticamente.

[GitHub Actions](https://github.com/juansemartinez01/innoview-platform/actions/workflows/ci.yml) ejecuta instalación congelada, lint, formato, tipos, scripts de tests existentes y build en cada push y pull request. También permite ejecución manual. No necesita secretos de aplicación, no despliega y tiene permisos de solo lectura. Las acciones están fijadas por SHA.

Versiones, fuentes, compatibilidad de ESLint 10 y riesgos: docs/FOUNDATION.md. Próximo incremento propuesto: **0.4, entorno Docker PostgreSQL/Keycloak**, después de revisar 0.3.
