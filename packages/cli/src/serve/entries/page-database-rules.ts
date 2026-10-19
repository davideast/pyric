/** The page's in-page RTDB rules deployment, on the realm-local sandbox the page runtime owns. */
import { sandbox } from './app-backend.js';
import { createDatabaseRulesDeployment } from './database-rules.js';

export const databaseRules = createDatabaseRulesDeployment(sandbox);
