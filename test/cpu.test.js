import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clampPercent,
  computeAggregateCpuPercent,
  computeProcessCpuPercents,
  round1,
  topProcessLists,
  withCpuPercent,
} from '../lib/cpu.js';
import { makeProcess, makeProcessSnapshot } from './helpers.js';

test('round1 and clampPercent keep percentages in range', () => {
  assert.equal(round1(12.345), 12.3);
  assert.equal(round1(-0.04), 0);
  assert.equal(round1(Number.NaN), 0);
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(33.333), 33.3);
  assert.equal(clampPercent(Number.POSITIVE_INFINITY), 0);
});

test('computeAggregateCpuPercent computes an idle/total delta', () => {
  assert.equal(computeAggregateCpuPercent({ idleMs: 1000, totalMs: 2000 }, { idleMs: 1100, totalMs: 2200 }), 50);
  assert.equal(computeAggregateCpuPercent({ idleMs: 1000, totalMs: 2000 }, { idleMs: 2000, totalMs: 3000 }), 0);
  assert.equal(computeAggregateCpuPercent({ idleMs: 1000, totalMs: 2000 }, { idleMs: 1000, totalMs: 3000 }), 100);
  assert.equal(computeAggregateCpuPercent({ idleMs: 1000, totalMs: 2000 }, { idleMs: 1000, totalMs: 2000 }), null);
  assert.equal(computeAggregateCpuPercent({ idleMs: 2000, totalMs: 2000 }, { idleMs: 1000, totalMs: 3000 }), null);
});

test('computeProcessCpuPercents turns cumulative CPU deltas into system percentages', () => {
  const previous = makeProcessSnapshot(1000, [
    makeProcess({ pid: 10, cpuMs: 0 }),
    makeProcess({ pid: 20, cpuMs: 0 }),
    makeProcess({ pid: 30, cpuMs: 0 }),
  ]);
  const current = makeProcessSnapshot(2000, [
    makeProcess({ pid: 10, cpuMs: 300 }),
    makeProcess({ pid: 20, cpuMs: 0 }),
    makeProcess({ pid: 30, cpuMs: 400 }),
    makeProcess({ pid: 40, cpuMs: 100 }),
  ]);
  const percentages = computeProcessCpuPercents(previous, current, 4);
  assert.equal(percentages.get(10), 7.5);
  assert.equal(percentages.get(20), 0);
  assert.equal(percentages.get(30), 10);
  assert.equal(percentages.get(40), 0);
});

test('computeProcessCpuPercents clamps and ignores impossible deltas', () => {
  const previous = makeProcessSnapshot(1000, [makeProcess({ pid: 10, cpuMs: 500 })]);
  const current = makeProcessSnapshot(1100, [makeProcess({ pid: 10, cpuMs: 400 })]);
  assert.equal(computeProcessCpuPercents(previous, current, 1).get(10), 0);
  const busy = computeProcessCpuPercents(
    makeProcessSnapshot(1000, [makeProcess({ pid: 10, cpuMs: 0 })]),
    makeProcessSnapshot(1100, [makeProcess({ pid: 10, cpuMs: 5000 })]),
    1,
  );
  assert.equal(busy.get(10), 100);
});

test('computeProcessCpuPercents falls back to pcpu hints without a baseline', () => {
  const current = makeProcessSnapshot(1000, [
    makeProcess({ pid: 10, cpuMs: null, pcpu: 200 }),
    makeProcess({ pid: 11, cpuMs: null, pcpu: 50 }),
  ]);
  const percentages = computeProcessCpuPercents(null, current, 4);
  assert.equal(percentages.get(10), 50);
  assert.equal(percentages.get(11), 12.5);
});

test('computeProcessCpuPercents handles a non-advancing window', () => {
  const snapshot = makeProcessSnapshot(1000, [makeProcess({ pid: 10, cpuMs: 100 })]);
  const percentages = computeProcessCpuPercents(snapshot, { at: 500, processes: snapshot.processes }, 4);
  assert.equal(percentages.get(10), 0);
});

test('withCpuPercent merges percentages without mutating input', () => {
  const processes = [makeProcess({ pid: 10 }), makeProcess({ pid: 20 })];
  const merged = withCpuPercent(processes, new Map([[10, 5.5]]));
  assert.equal(merged[0].cpuPercent, 5.5);
  assert.equal(merged[1].cpuPercent, 0);
  assert.equal('cpuPercent' in processes[0], false);
});

test('topProcessLists sorts by RAM and CPU with deterministic ties', () => {
  const processes = withCpuPercent(
    [
      makeProcess({ pid: 1, name: 'a.exe', ramBytes: 300 }),
      makeProcess({ pid: 2, name: 'b.exe', ramBytes: 500 }),
      makeProcess({ pid: 3, name: 'c.exe', ramBytes: 400 }),
    ],
    new Map([[1, 90], [2, 10], [3, 50]]),
  );
  const { topRam, topCpu } = topProcessLists(processes, 2);
  assert.deepEqual(topRam.map((process) => process.pid), [2, 3]);
  assert.deepEqual(topCpu.map((process) => process.pid), [1, 3]);
});
