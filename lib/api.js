/**
 * HTTP JSON API behind the Host health panel.
 *
 * The panel is a browser surface, so it needs live host numbers outside the
 * conversation pipeline. Every route is registered through the composed
 * `webServer` and admitted by the `connection` trust fence: an unauthenticated
 * request is rejected before any probe runs. Responses carry the structured
 * service value, its rendered text, and the running plugin version so a stale
 * Host generation is visible from the panel.
 *
 * Kill actions are user-driven panel clicks; they call the same service methods
 * as the approval-gated tools, so identity re-verification and protected-PID
 * refusals are identical on both paths.
 *
 * @module
 */

import { renderHostStats, renderKillResult, renderPortsList, renderStaleProcesses } from './render.js';

/** Prefix owned by this plugin; nothing else may register under it. */
export const HOST_HEALTH_API_PREFIX = '/dsh-host-health/api/';

/** Plugin version reported to the panel so a stale Host generation is visible. */
export const PLUGIN_VERSION = '0.1.0';

/** Panel request bodies are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Register the panel API on the plugin context.
 *
 * @param {any} ctx Plugin context with `webServer` and `connection`.
 * @param {ReturnType<typeof import('./service.js').createHostService>} service Host service.
 * @returns {void}
 */
export function registerHostHealthApi(ctx, service) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: HOST_HEALTH_API_PREFIX,
        handler: (
          /** @type {import('node:http').IncomingMessage} */ req,
          /** @type {import('node:http').ServerResponse} */ res,
        ) => handle(ctx, service, req, res),
      }),
    'host-health: panel http api',
  );
}

/**
 * Route one panel request.
 *
 * @param {any} ctx Plugin context.
 * @param {ReturnType<typeof import('./service.js').createHostService>} service Host service.
 * @param {import('node:http').IncomingMessage} req Request.
 * @param {import('node:http').ServerResponse} res Response.
 * @returns {Promise<void>} settled response.
 */
async function handle(ctx, service, req, res) {
  try {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return;
    }
    const url = new URL(String(req.url ?? '/'), 'http://localhost');
    const endpoint = url.pathname.slice(HOST_HEALTH_API_PREFIX.length).replace(/\/+$/u, '');
    if (req.method === 'GET' && endpoint === 'stats') {
      const value = await service.hostStats({});
      sendJson(res, 200, { ok: true, pluginVersion: PLUGIN_VERSION, value, text: renderHostStats(value) });
      return;
    }
    if (req.method === 'GET' && endpoint === 'ports') {
      const value = await service.portsList({});
      sendJson(res, 200, { ok: true, pluginVersion: PLUGIN_VERSION, value, text: renderPortsList(value) });
      return;
    }
    if (req.method === 'GET' && endpoint === 'stale') {
      const value = await service.staleDevProcesses();
      sendJson(res, 200, { ok: true, pluginVersion: PLUGIN_VERSION, value, text: renderStaleProcesses(value) });
      return;
    }
    if (req.method === 'POST' && endpoint === 'kill') {
      sendJson(res, 200, await kill(service, req));
      return;
    }
    if (req.method === 'GET' && endpoint === 'version') {
      sendJson(res, 200, { ok: true, pluginVersion: PLUGIN_VERSION });
      return;
    }
    sendJson(res, 404, { ok: false, error: `unknown host-health api endpoint: ${endpoint}` });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        ok: false,
        error: 'host-health api failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    } else {
      res.end();
    }
  }
}

/**
 * `POST kill`: terminate one listener or process after a fresh identity check.
 *
 * @param {ReturnType<typeof import('./service.js').createHostService>} service Host service.
 * @param {import('node:http').IncomingMessage} req Request.
 * @returns {Promise<Record<string, unknown>>} panel payload.
 */
async function kill(service, req) {
  const body = await readJsonBody(req);
  if (body === null) return { ok: false, error: 'request body must be a JSON object under 64 KiB' };
  const port = Number(body.port);
  const pid = Number(body.pid);
  let value;
  if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
    value = await service.portKill(port);
  } else if (Number.isInteger(pid) && pid > 0) {
    value = await service.processKill(pid, typeof body.expectedName === 'string' ? body.expectedName : undefined);
  } else {
    return { ok: false, error: 'kill requires an integer port (1-65535) or pid (> 0)' };
  }
  return {
    ok: true,
    pluginVersion: PLUGIN_VERSION,
    value,
    text: renderKillResult(value),
  };
}

/**
 * Read a bounded JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req Request.
 * @returns {Promise<Record<string, any> | null>} parsed object, or null when invalid/oversized.
 */
async function readJsonBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Write one JSON response.
 *
 * @param {import('node:http').ServerResponse} res Response.
 * @param {number} status Status code.
 * @param {unknown} payload JSON payload.
 * @returns {void}
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}
