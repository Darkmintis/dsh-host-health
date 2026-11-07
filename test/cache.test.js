import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCache } from '../lib/cache.js';

test('cache returns values until the injected clock passes the TTL', () => {
  let now = 1000;
  const cache = createCache({ now: () => now });
  cache.set('key', { value: 1 }, 2500);
  assert.deepEqual(cache.get('key'), { value: 1 });
  assert.equal(cache.has('key'), true);
  now = 3499;
  assert.deepEqual(cache.get('key'), { value: 1 });
  now = 3500;
  assert.equal(cache.get('key'), undefined);
  assert.equal(cache.has('key'), false);
});

test('cache stores undefined-free values and supports delete/clear', () => {
  const cache = createCache({ now: () => 0 });
  cache.set('a', 1, 10);
  cache.set('b', 2, 10);
  assert.equal(cache.size(), 2);
  assert.equal(typeof cache.get('missing'), 'undefined');
  cache.delete('a');
  assert.equal(cache.get('a'), undefined);
  cache.clear();
  assert.equal(cache.size(), 0);
});

test('cache treats a zero TTL as immediately stale', () => {
  const cache = createCache({ now: () => 100 });
  cache.set('key', 'value', 0);
  assert.equal(cache.get('key'), undefined);
});

test('cache overwrites earlier entries and extends expiry', () => {
  let now = 0;
  const cache = createCache({ now: () => now });
  cache.set('key', 'first', 100);
  cache.set('key', 'second', 1000);
  now = 999;
  assert.equal(cache.get('key'), 'second');
  now = 1000;
  assert.equal(cache.get('key'), undefined);
});
