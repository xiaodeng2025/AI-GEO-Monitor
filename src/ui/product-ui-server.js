import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MonitoringApplication } from '../application/monitoring-application.js';
import { ProductionPlanExecutor } from '../application/production-plan-executor.js';
import { openDatabase, GeoRepository } from '../db/repository.js';
import { createLocalProductTransport } from './local-product-transport.js';

export const PRODUCT_UI_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const PRODUCT_UI_RUNTIME_PROFILES_ROOT = resolve(PRODUCT_UI_REPOSITORY_ROOT, 'profiles');

export function createProductUiApplication({ repository }) {
  return new MonitoringApplication({
    repository,
    // Data and artifacts intentionally retain the server's cwd so validation
    // runs remain isolated. Browser profiles are runtime state and must stay
    // anchored to this checked-out Product UI implementation.
    planExecutor: new ProductionPlanExecutor({ repository, profilesRoot: PRODUCT_UI_RUNTIME_PROFILES_ROOT })
  });
}

export function createProductUiServer({ app, staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../ui') }) {
  const handle = createLocalProductTransport({ app, staticRoot });
  return createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = null; }
    const result = await handle({ method: request.method, url: request.url, body: parsed });
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDatabase(resolve('data', 'geo-monitor.sqlite'));
  const repository = new GeoRepository(db);
  const app = createProductUiApplication({ repository });
  const server = createProductUiServer({ app });
  const port = Number(process.env.PORT ?? 4173);
  server.listen(port, '127.0.0.1', () => console.log(`AI-GEO-Monitor Product UI: http://127.0.0.1:${port}`));
  const close = () => { server.close(() => db.close()); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
