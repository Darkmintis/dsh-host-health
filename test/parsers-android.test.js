import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cpuPercentFromDelta, parseAdbDevices, parseAndroidSnapshot } from '../lib/parsers-android.js';

const fixtures = path.join(import.meta.dirname, 'fixtures');

/**
 * @param {string} name Fixture file name.
 * @returns {string} contents.
 */
function fixture(name) {
  return readFileSync(path.join(fixtures, name), 'utf8');
}

test('parseAdbDevices keeps ready devices and drops offline ones', () => {
  const devices = parseAdbDevices(fixture('adb-devices-l.txt'));
  assert.equal(devices.length, 1, 'only the online phone is kept');
  assert.equal(devices[0].serial, 'TESTDEVICE01');
  assert.equal(devices[0].state, 'device');
  assert.match(devices[0].model ?? '', /SM[_ ]M127G/u);
});

test('parseAndroidSnapshot reads real phone memory, storage, battery, and props', () => {
  const raw = fixture('adb-snapshot.txt');
  const snapshot = parseAndroidSnapshot(raw);
  const memTotalKb = Number(/MemTotal:\s+(\d+)\s+kB/u.exec(raw)[1]);
  const memAvailableKb = Number(/MemAvailable:\s+(\d+)\s+kB/u.exec(raw)[1]);
  assert.ok(snapshot.memory);
  assert.equal(snapshot.memory.totalBytes, memTotalKb * 1024);
  assert.equal(snapshot.memory.availableBytes, memAvailableKb * 1024);
  assert.equal(snapshot.memory.usedBytes, (memTotalKb - memAvailableKb) * 1024);
  assert.ok(snapshot.memory.usedPercent > 0 && snapshot.memory.usedPercent <= 100);

  const dfCells = raw.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('/dev/block')).at(-1).split(/\s+/u);
  assert.ok(snapshot.storage);
  assert.equal(snapshot.storage.totalBytes, Number(dfCells[1]) * 1024);
  assert.equal(snapshot.storage.freeBytes, Number(dfCells[3]) * 1024);
  assert.ok(snapshot.storage.usedPercent > 0 && snapshot.storage.usedPercent <= 100);

  const level = Number(/^\s*level:\s*(\d+)/mu.exec(raw)[1]);
  const status = Number(/^\s*status:\s*(\d+)/mu.exec(raw)[1]);
  const temperature = Number(/^\s*temperature:\s*(\d+)/mu.exec(raw)[1]);
  assert.ok(snapshot.battery);
  assert.equal(snapshot.battery.percent, level);
  assert.equal(snapshot.battery.charging, status === 2 || status === 5);
  assert.equal(snapshot.battery.temperatureC, Math.round(temperature / 10));
  assert.equal(snapshot.model, 'SM-M127G');
  assert.equal(snapshot.androidVersion, '13');
  assert.equal(snapshot.sdk, 33);
  assert.ok(snapshot.cpuTimes);
  assert.ok(snapshot.cpuTimes.totalMs > 0);
  assert.ok(snapshot.cpuTimes.idleMs > 0);
});

test('parseAndroidSnapshot tolerates malformed output', () => {
  const empty = parseAndroidSnapshot('');
  assert.equal(empty.memory, null);
  assert.equal(empty.storage, null);
  assert.equal(empty.battery, null);
  assert.equal(empty.cpuTimes, null);

  const partial = parseAndroidSnapshot('MemTotal: nope\n===DSH===\ncpu x y\n===DSH===\n===DSH===\nlevel: 900\n');
  assert.equal(partial.memory, null);
  assert.equal(partial.cpuTimes, null);
  assert.equal(partial.battery?.percent, 100, 'battery percentages are clamped');
});

test('cpuPercentFromDelta follows cumulative processor counters', () => {
  assert.equal(cpuPercentFromDelta({ totalMs: 1000, idleMs: 600 }, { totalMs: 2000, idleMs: 1200 }), 40);
  assert.equal(cpuPercentFromDelta({ totalMs: 1000, idleMs: 600 }, { totalMs: 1000, idleMs: 600 }), null, 'no delta is unusable');
  assert.equal(cpuPercentFromDelta({ totalMs: 2000, idleMs: 1000 }, { totalMs: 1000, idleMs: 500 }), null, 'counter reset is unusable');
});
