/**
 * Tool definitions for the host-health plugin.
 *
 * The structured `execute` value stays small and predictable; all human-readable
 * tables live in `output.render`, which the Host turns into text content
 * blocks. Failures are returned as `{ ok: false, error, hint? }` values — the
 * plugin never throws stack traces at the model.
 * @module host-health/tools
 */

import { TOOL_NAMES } from './constants.js';
import {
  renderError,
  renderHostStats,
  renderKillResult,
  renderPortsList,
  renderStaleProcesses,
} from './render.js';

/**
 * @typedef {import('./service.js').HostService} HostService
 * @typedef {{ type: 'text', text: string }} TextContentBlock
 * @typedef {object} ToolDefinition
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} parameters
 * @property {{ schema: Record<string, unknown>, render: (args: Record<string, any>, value: Record<string, any>) => TextContentBlock[], presentationMeta?: (args: Record<string, any>, value: Record<string, any>) => unknown }} output
 * @property {number} timeoutMs
 * @property {(args: Record<string, any>) => Promise<Record<string, any>>} execute
 */

/** Output schema for every tool: an object that always carries `ok`. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'Whether the tool call succeeded.' },
  },
  required: ['ok'],
  additionalProperties: true,
};

/**
 * @param {string} text
 * @returns {TextContentBlock[]}
 */
function textBlocks(text) {
  return [{ type: 'text', text: typeof text === 'string' && text !== '' ? text : 'No data.' }];
}

/**
 * @param {unknown} value
 * @param {string} renderer
 * @param {(value: Record<string, any>) => string} render
 * @returns {TextContentBlock[]}
 */
function project(value, renderer, render) {
  try {
    if (value === null || typeof value !== 'object') return textBlocks('No data.');
    return textBlocks(render(/** @type {Record<string, any>} */ (value)));
  } catch {
    return textBlocks(`${renderer} could not format its result.`);
  }
}

/**
 * Wrap a service call so an unexpected rejection still becomes a structured
 * value instead of a thrown stack trace.
 * @param {string} toolName
 * @param {() => Promise<Record<string, any>>} call
 * @returns {Promise<Record<string, any>>}
 */
async function safeCall(toolName, call) {
  try {
    const value = await call();
    if (value === null || typeof value !== 'object') {
      return { ok: false, error: `${toolName}_failed`, hint: 'The tool returned no structured value.' };
    }
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${toolName}_failed`, hint: message };
  }
}

/**
 * Build all tool definitions bound to one service instance.
 * @param {HostService} service
 * @returns {ToolDefinition[]}
 */
export function createToolDefinitions(service) {
  return [
    {
      name: 'host_stats',
      description: 'Snapshot host RAM, CPU, disk, GPU, and top processes.',
      parameters: {
        type: 'object',
        properties: {
          includeProcesses: {
            type: 'boolean',
            description: 'Include top process lists (default true).',
          },
          includeGpu: {
            type: 'boolean',
            description: 'Try to read GPU data from nvidia-smi (default true).',
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(args, value) {
          return project(value, 'host_stats', (data) => (data.ok === false ? renderError(data) : renderHostStats(data)));
        },
        presentationMeta: (args, value) => value,
      },
      timeoutMs: 25000,
      execute: (args) => safeCall('host_stats', () => service.hostStats(args)),
    },
    {
      name: 'ports_list',
      description: 'List TCP listeners, flag known dev ports and conflicts.',
      parameters: {
        type: 'object',
        properties: {
          ports: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Extra TCP ports to flag, in addition to known dev ports.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(args, value) {
          return project(value, 'ports_list', (data) => (data.ok === false ? renderError(data) : renderPortsList(data)));
        },
        presentationMeta: (args, value) => value,
      },
      timeoutMs: 40000,
      execute: (args) => safeCall('ports_list', () => service.portsList(args)),
    },
    {
      name: 'stale_dev_processes',
      description: 'Find leftover dev servers, emulators, Flutter runs, Gradle daemons.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(args, value) {
          return project(value, 'stale_dev_processes', (data) =>
            data.ok === false ? renderError(data) : renderStaleProcesses(data),
          );
        },
        presentationMeta: (args, value) => value,
      },
      timeoutMs: 50000,
      execute: (args) => safeCall('stale_dev_processes', () => service.staleDevProcesses()),
    },
    {
      name: 'port_kill',
      description: 'Kill the process listening on a local port (requires approval).',
      parameters: {
        type: 'object',
        properties: {
          port: {
            type: 'integer',
            description: 'TCP port to free, 1-65535.',
          },
        },
        required: ['port'],
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(args, value) {
          return project(value, 'port_kill', (data) => renderKillResult(data));
        },
        presentationMeta: (args, value) => value,
      },
      timeoutMs: 90000,
      execute: (args) => safeCall('port_kill', () => service.portKill(Number(args.port))),
    },
    {
      name: 'process_kill',
      description: 'Kill a local process by PID (requires approval).',
      parameters: {
        type: 'object',
        properties: {
          pid: {
            type: 'integer',
            description: 'PID to kill; identity is re-checked before the kill.',
          },
          expectedName: {
            type: 'string',
            description: 'Optional expected process name; a mismatch aborts the kill.',
          },
        },
        required: ['pid'],
        additionalProperties: false,
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render(args, value) {
          return project(value, 'process_kill', (data) => renderKillResult(data));
        },
        presentationMeta: (args, value) => value,
      },
      timeoutMs: 45000,
      execute: (args) =>
        safeCall('process_kill', () =>
          service.processKill(Number(args.pid), typeof args.expectedName === 'string' ? args.expectedName : undefined),
        ),
    },
  ];
}

/** Registered tool names, re-exported for manifest checks. */
export { TOOL_NAMES };
