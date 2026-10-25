# Innoview Platform

Foundation MVP, incrementos 0.1 y 0.2. Fuente de verdad: AGENTS.md y docs/.

## Requisitos

Node.js 22 (>=22.15) o 24 (>=24.11), líneas LTS. Usar el último parche de la línea elegida. pnpm 11.25.0, fijado en packageManager. No se modifica la instalación global del equipo.

## Comandos desde la raíz

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm dev
```

Desarrollo: portal http://127.0.0.1:3000, Control Center http://127.0.0.1:3001 y API http://127.0.0.1:3002. Detener con Ctrl+C.

Después del build, ejecutar cada aplicación por separado con `pnpm --filter @innoview/portal start`, `pnpm --filter @innoview/control-center start` y `pnpm --filter @innoview/api start`.

Las páginas y la respuesta raíz de la API solo comprueban arranque. No hay acceso a datos, autenticación ni administración todavía. Los servidores escuchan únicamente en loopback. No son una configuración de producción.

## Límites actuales

Sin paquetes compartidos vacíos, módulos comerciales, worker, CI, lint/formato, Docker ni persistencia. TypeScript tiene configuración mínima para compilar las aplicaciones; la política completa de calidad corresponde a 0.3. TypeORM está aprobado, pero se incorpora junto con migraciones en 0.5. Keycloak/OIDC se integra en Fase 1, después del entorno local de 0.4.

Versiones, fuentes y riesgos: docs/FOUNDATION.md. Próximo incremento: 0.3, calidad y CI; requiere validación previa de este incremento.
