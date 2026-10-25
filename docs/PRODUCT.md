# Innoview Platform — visión del producto

## Propósito
Innoview desarrolla software a medida. Se busca una plataforma empresarial transversal, modular y extensible que permita ofrecer módulos genéricos listos para usar y desarrollar o conectar sistemas personalizados sin repetir infraestructura.

## Dos líneas de negocio
1. Catálogo de módulos estándar, comercializables sin proyecto a medida.
2. Desarrollos exclusivos o reutilizables construidos sobre la misma plataforma.

## Capacidades de producto
- Core obligatorio; módulos genéricos y verticales opcionales.
- Catálogo y administración de módulos exclusivamente por el equipo Innoview en fase inicial.
- Portal con marca Innoview o white-label por cliente.
- Apps nativas visualmente consistentes y aplicaciones externas conectables sin reconstrucción completa.
- Cloud compartida multiempresa o despliegue dedicado, sin mantener forks por cliente. Tenant identifica el límite lógico del cliente; Deployment identifica la instancia de ejecución que aloja uno o varios tenants.
- Grupo empresarial → varias empresas → varias sucursales. Compartición entre empresas configurable y denegada por defecto.
- Administradores de empresa gestionan usuarios, invitaciones y roles dentro de su autoridad; Innoview gestiona catálogo, despliegues y habilitaciones.

## Catálogo candidato (no comprometido para MVP)
Directorio de terceros, documentos, tareas, cuentas corrientes, compras, ventas, tesorería, inventario, activos y verticales personalizados. Priorizar pruebas de reutilización antes de ampliar el catálogo.

## Objetivo del Foundation MVP
Demostrar autenticación y permisos multiempresa, aislamiento y capacidad de habilitar un módulo de prueba. No es todavía un ERP comercial completo.
