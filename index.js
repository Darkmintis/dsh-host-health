/**
 * DeepSeek Harness host-health plugin (Host half).
 *
 * Registers five tools — `host_stats`, `ports_list`, `stale_dev_processes`,
 * `port_kill`, `process_kill` — plus the approval policy that makes the two kill
 * tools ask before they run. Read-only tools never ask.
 *
 * The plugin reads host state only; it never writes files, never sends
 * telemetry, never uses the network, and never requests administrator rights.
 * @module @darkmintis/dsh-host-health
 */

import { DESTRUCTIVE_TOOLS, DEFAULT_LIMITS, DEFAULT_THRESHOLDS } from './lib/constants.js';
import { createCommandRunner } from './lib/command.js';
import { createNodeSystem } from './lib/system.js';
import { createProbes } from './lib/probes.js';
import { createProcessControl } from './lib/kill.js';
import { registerHostHealthApi } from './lib/api.js';
import { createHostService } from './lib/service.js';
import { createToolDefinitions } from './lib/tools.js';

/** Required Host services. */
export const inject = ['tools'];

/** Plugin display name (also the client module id). */
export const name = '@darkmintis/dsh-host-health';

/**
 * Minimal structural view of the Cordis Host context used by this plugin.
 * @typedef {object} HostContext
 * @property {(callback: () => unknown, label?: string) => unknown} effect
 * @property {(event: string, listener: (exec: Record<string, any>, next: () => Promise<any>) => Promise<any>) => unknown} on
 * @property {(dependencies: string[], callback: (ctx: any) => unknown) => unknown} inject
 * @property {{ register: (definition: Record<string, any>) => unknown }} tools
 */

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} minimum
 * @returns {number}
 */
function numberSetting(value, fallback, minimum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : fallback;
}

/**
 * Resolve optional runtime settings defensively. The bundle patch ships
 * `config: {}`; every value has a safe default.
 * @param {unknown} config
 * @returns {{ limits: Partial<typeof DEFAULT_LIMITS>, thresholds: Partial<typeof DEFAULT_THRESHOLDS> }}
 */
function resolveSettings(config) {
  const source = config !== null && typeof config === 'object' ? /** @type {Record<string, unknown>} */ (config) : {};
  const thresholdSource =
    source.thresholds !== null && typeof source.thresholds === 'object'
      ? /** @type {Record<string, unknown>} */ (source.thresholds)
      : {};
  return {
    limits: {
      cacheTtlMs: numberSetting(source.cacheTtlMs, DEFAULT_LIMITS.cacheTtlMs, 0),
      staleAfterMinutes: numberSetting(source.staleAfterMinutes, DEFAULT_LIMITS.staleAfterMinutes, 1),
      maxProcesses: numberSetting(source.maxProcesses, DEFAULT_LIMITS.maxProcesses, 1),
      maxStaleEntries: numberSetting(source.maxStaleEntries, DEFAULT_LIMITS.maxStaleEntries, 1),
    },
    thresholds: {
      ramPercent: numberSetting(thresholdSource.ramPercent, DEFAULT_THRESHOLDS.ramPercent, 1),
      diskFreeBytes: numberSetting(thresholdSource.diskFreeBytes, DEFAULT_THRESHOLDS.diskFreeBytes, 0),
      diskFreePercent: numberSetting(thresholdSource.diskFreePercent, DEFAULT_THRESHOLDS.diskFreePercent, 0),
    },
  };
}

/**
 * @param {Record<string, unknown>} args
 * @returns {boolean}
 */
function hasValidPort(args) {
  const port = args.port;
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * @param {Record<string, unknown>} args
 * @returns {boolean}
 */
function hasValidPid(args) {
  const pid = args.pid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

/**
 * Plugin entry: build the service, register the tools and the approval policy.
 * @param {HostContext} ctx Host context.
 * @param {unknown} [config] Raw bundle row config (`{}` by default).
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config);
  const commandRunner = createCommandRunner({});
  const probes = createProbes({
    commandRunner,
    platform: process.platform,
    cacheTtlMs: settings.limits.cacheTtlMs,
  });
  const system = createNodeSystem({});
  const control = createProcessControl({});
  const service = createHostService({
    system,
    probes,
    control,
    limits: settings.limits,
    thresholds: settings.thresholds,
    config: config !== null && typeof config === 'object' ? /** @type {Record<string, unknown>} */ (config) : {},
  });

  for (const definition of createToolDefinitions(service)) {
    ctx.effect(() => ctx.tools.register(definition), `host-health: register ${definition.name}`);
  }

  // The panel API only exists where the Web composition provides a browser
  // carrier and its trust fence; headless profiles keep the tools only.
  ctx.inject(['webServer', 'connection'], (/** @type {any} */ apiCtx) => {
    registerHostHealthApi(apiCtx, service);
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = typeof exec.name === 'string' ? exec.name : '';
    if (!DESTRUCTIVE_TOOLS.includes(toolName)) return next();
    const args = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {};
    // Invalid targets cannot kill anything: let the tool return its validation
    // error without spending the user's attention on an approval prompt.
    if (toolName === 'port_kill' && !hasValidPort(args)) return next();
    if (toolName === 'process_kill' && !hasValidPid(args)) return next();
    const target = toolName === 'port_kill' ? `TCP port ${args.port}` : `process PID ${args.pid}`;
    return {
      kind: 'ask',
      reason: `Kill the ${target}? This terminates a local process and cannot be undone. The listener or process identity is re-checked immediately before the kill.`,
    };
  });
}
