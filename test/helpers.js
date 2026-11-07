/**
 * Shared test helpers: deterministic clocks, fake probes/system/process
 * control, and fixture builders. No live host access is required.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const fixturesDir = path.join(import.meta.dirname, 'fixtures');

/**
 * @param {string} name
 * @returns {string}
 */
export function fixture(name) {
  return readFileSync(path.join(fixturesDir, name), 'utf8');
}

/**
 * A controllable clock whose sleep advances time deterministically.
 * @param {number} [start]
 */
export function createTestClock(start = 1_000_000) {
  const state = { now: start };
  return {
    now: () => state.now,
    advance(ms) {
      state.now += ms;
      return state.now;
    },
    sleep: async (ms) => {
      state.now += ms;
    },
  };
}

/**
 * Return items in call order, repeating the last one.
 * @template T
 * @param {T[]} values
 * @returns {() => T}
 */
export function sequence(values) {
  if (values.length === 0) throw new Error('sequence needs at least one value');
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

/**
 * Build a ProcessInfo record with sensible defaults.
 * @param {Partial<import('../lib/types.js').ProcessInfo>} overrides
 * @returns {import('../lib/types.js').ProcessInfo}
 */
export function makeProcess(overrides = {}) {
  return {
    pid: 100,
    ppid: 1,
    name: 'node.exe',
    ramBytes: 100 * 1024 * 1024,
    cpuMs: 0,
    pcpu: null,
    startedAt: null,
    commandLine: 'node app.js',
    ...overrides,
  };
}

/**
 * @param {number} at
 * @param {import('../lib/types.js').ProcessInfo[]} processes
 * @returns {import('../lib/types.js').ProcessSnapshot}
 */
export function makeProcessSnapshot(at, processes) {
  return { at, processes };
}

/**
 * @param {number} at
 * @param {import('../lib/types.js').PortListener[]} listeners
 * @returns {import('../lib/types.js').ListenerSnapshot}
 */
export function makeListenerSnapshot(at, listeners) {
  return { at, listeners };
}

/**
 * Fake probe set with call counters.
 * @param {{
 *   processTables?: Array<import('../lib/types.js').ProcessSnapshot>,
 *   listeners?: Array<import('../lib/types.js').ListenerSnapshot>,
 *   gpu?: Array<import('../lib/types.js').GpuInfo|null>,
 * }} [options]
 */
export function createFakeProbes(options = {}) {
  const processTables = options.processTables ?? [makeProcessSnapshot(1_000_000, [])];
  const listenerSnapshots = options.listeners ?? [makeListenerSnapshot(1_000_000, [])];
  const gpuValues = options.gpu ?? [null];
  const processTableSeq = sequence(processTables);
  const listenerSeq = sequence(listenerSnapshots);
  const gpuSeq = sequence(gpuValues);
  const calls = { processTable: 0, listeners: 0, gpu: 0, freshProcessTable: 0, freshListeners: 0 };
  return {
    calls,
    async processTable(probeOptions = {}) {
      calls.processTable += 1;
      if (probeOptions.fresh === true) calls.freshProcessTable += 1;
      return processTableSeq();
    },
    async listeners(probeOptions = {}) {
      calls.listeners += 1;
      if (probeOptions.fresh === true) calls.freshListeners += 1;
      return listenerSeq();
    },
    async gpu() {
      calls.gpu += 1;
      return gpuSeq();
    },
    clearNotes() {},
    clearCache() {},
    notes() {
      return [];
    },
  };
}

/**
 * Fake system adapter.
 * @param {Partial<Record<string, any>>} [overrides]
 */
export function createFakeSystem(overrides = {}) {
  /** @type {import('../lib/types.js').CpuTimes[]} */
  const cpuTimes = overrides.cpuTimes ?? [
    { idleMs: 1000, totalMs: 2000 },
    { idleMs: 1100, totalMs: 2200 },
  ];
  const cpuSeq = sequence(cpuTimes);
  return {
    platform: 'win32',
    arch: 'x64',
    cpuCount: 4,
    hostname: () => 'test-host',
    memory: () => ({ totalBytes: 16 * 1024 ** 3, freeBytes: 4 * 1024 ** 3, usedBytes: 12 * 1024 ** 3, usedPercent: 75 }),
    cpuTimes: () => cpuSeq(),
    uptimeSeconds: () => 7200,
    loadAvg: () => [1.5, 1.2, 1],
    disk: async () => ({
      path: 'C:\\',
      totalBytes: 500 * 1024 ** 3,
      freeBytes: 200 * 1024 ** 3,
      usedBytes: 300 * 1024 ** 3,
      freePercent: 40,
    }),
    ...overrides,
  };
}

/**
 * Fake process control with an alive-pid set.
 * @param {{ alive?: number[], selfPid?: number, parentPid?: number, killError?: unknown }} [options]
 */
export function createFakeControl(options = {}) {
  const alive = new Set(options.alive ?? []);
  const sleeps = [];
  const clock = { now: 0 };
  return {
    alive,
    sleeps,
    setNow(value) {
      clock.now = value;
    },
    exists(pid) {
      return alive.has(pid);
    },
    kill(pid) {
      if (options.killError !== undefined) throw options.killError;
      alive.delete(pid);
    },
    async sleep(ms) {
      sleeps.push(ms);
      clock.now += ms;
    },
    selfPid: options.selfPid ?? 4242,
    parentPid: options.parentPid ?? 1,
    get now() {
      return clock.now;
    },
  };
}

/**
 * Fake Cordis Host context capturing registrations and listeners.
 */
export function createFakeHostContext() {
  /** @type {Array<Record<string, any>>} */
  const registrations = [];
  /** @type {Map<string, (...args: any[]) => any>} */
  const listeners = new Map();
  /** @type {string[]} */
  const effectLabels = [];
  return {
    registrations,
    listeners,
    effectLabels,
    ctx: {
      effect(callback, label) {
        effectLabels.push(label);
        return callback();
      },
      on(event, listener) {
        listeners.set(event, listener);
        return () => {};
      },
      tools: {
        register(definition) {
          registrations.push(definition);
          return () => {};
        },
      },
    },
  };
}

/**
 * Minimal fake React used to exercise the client cards in a VM.
 */
export function createFakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children } };
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect() {},
  };
}
