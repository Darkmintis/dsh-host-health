/**
 * Small in-memory TTL cache used for expensive probes.
 *
 * The cache never writes to disk: repeated polls within the TTL reuse the last
 * probe result so `host_stats`/`ports_list` are cheap to call in a loop.
 * @module host-health/cache
 */

/**
 * @typedef {object} CacheEntry
 * @property {unknown} value Cached value.
 * @property {number} expiresAt Epoch milliseconds when the entry goes stale.
 */

/**
 * @typedef {object} Cache
 * @property {(key: string) => unknown} get Fresh value, or undefined.
 * @property {(key: string, value: unknown, ttlMs: number) => void} set
 * @property {(key: string) => boolean} has Fresh entry present.
 * @property {(key: string) => void} delete
 * @property {() => void} clear
 * @property {() => number} size Number of stored entries, including stale ones.
 */

/**
 * Create a clock-injectable TTL cache.
 * @param {{ now?: () => number }} [options]
 * @returns {Cache}
 */
export function createCache(options = {}) {
  const now = options.now ?? Date.now;
  /** @type {Map<string, CacheEntry>} */
  const entries = new Map();

  /** @param {string} key */
  function isFresh(key) {
    const entry = entries.get(key);
    if (entry === undefined) return false;
    return entry.expiresAt > now();
  }

  return {
    get(key) {
      return isFresh(key) ? /** @type {CacheEntry} */ (entries.get(key)).value : undefined;
    },
    set(key, value, ttlMs) {
      entries.set(key, { value, expiresAt: now() + Math.max(0, ttlMs) });
    },
    has(key) {
      return isFresh(key);
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}
