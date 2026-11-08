import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOST_HEALTH_API_PREFIX, registerHostHealthApi } from '../lib/api.js';

/**
 * Fake host service exposing the panel-relevant methods.
 * @param {Record<string, unknown>} [overrides] Method overrides.
 * @returns {any} service double.
 */
function makeService(overrides = {}) {
  const stats = {
    ok: true,
    pluginVersion: '0.1.0',
    host: { hostname: 'dev-box', platform: 'win32', arch: 'x64', cpuCount: 8, uptimeSeconds: 7320 },
    cpu: { percent: 12.5 },
    memory: { totalBytes: 16 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, freeBytes: 8 * 1024 ** 3, usedPercent: 50 },
    disk: { path: 'C:\\', totalBytes: 500 * 1024 ** 3, freeBytes: 200 * 1024 ** 3, usedPercent: 60, freePercent: 40 },
    load: [1.5, 1.2, 1],
    gpu: null,
    gpuStatus: 'unavailable',
    topRam: [],
    topCpu: [],
    devProcesses: [],
    warnings: [],
    notes: [],
    thresholds: { ramPercent: 85, diskFreeBytes: 10 * 1024 ** 3, diskFreePercent: 10 },
    listenerSource: 'Get-NetTCPConnection',
    listenerProbeAvailable: true,
  };
  return {
    hostStats: async () => stats,
    portsList: async () => ({ ok: true, available: true, source: 'Get-NetTCPConnection', listeners: [], flagged: [], warnings: [], notes: [] }),
    staleDevProcesses: async () => ({ ok: true, entries: [], staleAfterMinutes: 30, notes: [] }),
    portKill: async (port) => ({ ok: true, killed: { port, pid: 100, name: 'node.exe' }, verifiedGone: true }),
    processKill: async (pid, expectedName) => ({ ok: true, killed: { pid, name: expectedName ?? 'node.exe' }, verifiedGone: true }),
    ...overrides,
  };
}

/**
 * @param {any} service Host service double.
 * @param {{ reject?: number }} [options] Auth behavior.
 * @returns {{ call: (req: any, res: any) => Promise<void> }} route handler.
 */
function makeApi(service, options = {}) {
  /** @type {any} */
  let route;
  const ctx = {
    effect: (callback) => {
      callback();
      return () => {};
    },
    webServer: {
      register: (registered) => {
        route = registered;
        return () => {};
      },
    },
    connection: { requestRejection: () => options.reject },
  };
  registerHostHealthApi(ctx, service);
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, HOST_HEALTH_API_PREFIX);
  return { call: route.handler };
}

/**
 * @returns {any} response double.
 */
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    body: undefined,
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk;
      this.ended = true;
    },
  };
}

/**
 * @param {{ method?: string, url: string, body?: unknown }} options Request options.
 * @returns {any} request double.
 */
function makeReq(options) {
  const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  return {
    method: options.method ?? 'GET',
    url: options.url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield body;
    },
  };
}

/**
 * @param {any} res Response double.
 * @returns {any} parsed JSON.
 */
function jsonBody(res) {
  return JSON.parse(String(res.body));
}

test('panel API rejects an unauthenticated request before probing', async () => {
  const { call } = makeApi(makeService(), { reject: 401 });
  const res = makeRes();
  await call(makeReq({ url: `${HOST_HEALTH_API_PREFIX}stats` }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.ended, true);
  assert.equal(res.body, undefined);
});

test('GET stats returns structured host data, rendered text, and plugin version', async () => {
  const { call } = makeApi(makeService());
  const res = makeRes();
  await call(makeReq({ url: `${HOST_HEALTH_API_PREFIX}stats` }), res);
  const payload = jsonBody(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.pluginVersion, '0.1.0');
  assert.equal(payload.value.memory.usedPercent, 50);
  assert.match(String(payload.text), /dev-box/u);
});

test('GET ports and stale endpoints pass through the service values', async () => {
  const service = makeService({
    portsList: async () => ({
      ok: true,
      available: true,
      source: 'netstat',
      listeners: [{ port: 5173, address: '127.0.0.1', pid: 100, name: 'node.exe', knownDevPort: true, devLabel: 'Vite preview' }],
      flagged: [{ port: 5173, status: 'in_use', pid: 100, name: 'node.exe', knownDevPort: true, devLabel: 'Vite preview' }],
      warnings: [],
      notes: [],
    }),
    staleDevProcesses: async () => ({
      ok: true,
      entries: [
        {
          category: 'preview-server',
          label: 'Preview server',
          name: 'node.exe',
          pid: 100,
          port: 5173,
          ageMinutes: 140,
          stale: true,
          confidence: 'high',
          reason: 'Listening preview server older than the stale threshold.',
          suggested: { tool: 'port_kill', args: { port: 5173 }, note: 'Frees the port.' },
        },
      ],
      staleAfterMinutes: 30,
      notes: [],
    }),
  });
  const { call } = makeApi(service);

  const ports = makeRes();
  await call(makeReq({ url: `${HOST_HEALTH_API_PREFIX}ports` }), ports);
  const portsPayload = jsonBody(ports);
  assert.equal(portsPayload.value.listeners[0].port, 5173);
  assert.match(String(portsPayload.text), /5173/u);

  const stale = makeRes();
  await call(makeReq({ url: `${HOST_HEALTH_API_PREFIX}stale` }), stale);
  const stalePayload = jsonBody(stale);
  assert.equal(stalePayload.value.entries[0].stale, true);
  assert.match(String(stalePayload.text), /STALE/u);
});

test('POST kill routes a port target through portKill', async () => {
  /** @type {number[]} */
  const ports = [];
  const service = makeService({ portKill: async (port) => { ports.push(port); return { ok: true, killed: { port, pid: 100, name: 'node.exe' }, verifiedGone: true }; } });
  const { call } = makeApi(service);
  const res = makeRes();
  await call(makeReq({ method: 'POST', url: `${HOST_HEALTH_API_PREFIX}kill`, body: { port: 5173 } }), res);
  const payload = jsonBody(res);
  assert.deepEqual(ports, [5173]);
  assert.equal(payload.ok, true);
  assert.equal(payload.value.killed.port, 5173);
  assert.match(String(payload.text), /5173/u);
});

test('POST kill routes a pid target through processKill with the expected name', async () => {
  /** @type {Array<[number, string | undefined]>} */
  const calls = [];
  const service = makeService({
    processKill: async (pid, expectedName) => {
      calls.push([pid, expectedName]);
      return { ok: true, killed: { pid, name: expectedName ?? 'node.exe' }, verifiedGone: true };
    },
  });
  const { call } = makeApi(service);
  const res = makeRes();
  await call(makeReq({ method: 'POST', url: `${HOST_HEALTH_API_PREFIX}kill`, body: { pid: 4242, expectedName: 'node.exe' } }), res);
  assert.deepEqual(calls, [[4242, 'node.exe']]);
  assert.equal(jsonBody(res).ok, true);
});

test('POST kill rejects a body with no valid target', async () => {
  const { call } = makeApi(makeService());
  const res = makeRes();
  await call(makeReq({ method: 'POST', url: `${HOST_HEALTH_API_PREFIX}kill`, body: { port: 0 } }), res);
  assert.match(String(jsonBody(res).error), /integer port/u);

  const bad = makeRes();
  await call(makeReq({ method: 'POST', url: `${HOST_HEALTH_API_PREFIX}kill`, body: ['nope'] }), bad);
  assert.match(String(jsonBody(bad).error), /JSON object/u);
});

test('unknown endpoints and GET kill answer with a clear error', async () => {
  const { call } = makeApi(makeService());
  const missing = makeRes();
  await call(makeReq({ url: `${HOST_HEALTH_API_PREFIX}nope` }), missing);
  assert.equal(missing.statusCode, 404);
  assert.match(String(jsonBody(missing).error), /unknown host-health api endpoint/u);

  const getKill = makeRes();
  await call(makeReq({ url: `${HOST_HEALTH_API_PREFIX}kill` }), getKill);
  assert.equal(getKill.statusCode, 404);
});

test('GET version reports the running Host generation', async () => {
  const { call } = makeApi(makeService());
  const res = makeRes();
  await call(makeReq({ url: `${HOST_HEALTH_API_PREFIX}version` }), res);
  assert.deepEqual(jsonBody(res), { ok: true, pluginVersion: '0.1.0' });
});
