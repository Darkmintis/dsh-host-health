import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateThresholds, formatBytes } from '../lib/thresholds.js';

test('formatBytes renders human units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(10 * 1024 ** 3), '10 GB');
  assert.equal(formatBytes(-5), '0 B');
});

test('evaluateThresholds warns on high RAM and low disk', () => {
  const warnings = evaluateThresholds({
    memory: { totalBytes: 100, freeBytes: 10, usedBytes: 90, usedPercent: 90 },
    disk: { path: 'C:\\', totalBytes: 1000, freeBytes: 5, usedBytes: 995, freePercent: 0.5 },
  });
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].code, 'ram_high');
  assert.equal(warnings[1].code, 'disk_low');
  assert.match(warnings[0].message, /90%/);
  assert.match(warnings[1].message, /C:\\/);
});

test('evaluateThresholds stays quiet below thresholds', () => {
  const warnings = evaluateThresholds({
    memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 8 * 1024 ** 3, usedBytes: 8 * 1024 ** 3, usedPercent: 50 },
    disk: { path: '/', totalBytes: 500 * 1024 ** 3, freeBytes: 400 * 1024 ** 3, usedBytes: 100 * 1024 ** 3, freePercent: 80 },
  });
  assert.deepEqual(warnings, []);
});

test('evaluateThresholds accepts custom thresholds and missing inputs', () => {
  const warnings = evaluateThresholds({
    memory: { totalBytes: 100, freeBytes: 1, usedBytes: 99, usedPercent: 99 },
    thresholds: { ramPercent: 99.5 },
  });
  assert.deepEqual(warnings, []);
  assert.deepEqual(evaluateThresholds({}), []);
  assert.deepEqual(evaluateThresholds({ memory: null, disk: null }), []);
});
