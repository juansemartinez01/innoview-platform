import { createDataSource } from './data-sources.js';

// Loaded only by the migration CLI. Never imported by the NestJS module.
export default createDataSource('migrator');
