/**
 * adb discovery for the mobile half of `host_stats`.
 *
 * The plugin reads device health through the same adb binary the device-fleet
 * bundle uses. Resolution is read-only and deterministic: the `ADB`/`ANDROID_HOME`
 * environment first, then PATH, then the common SDK locations, so a machine with
 * the Android SDK works without extra configuration.
 *
 * @module host-health/adb
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Candidate adb file names per platform.
 * @param {NodeJS.Platform} platform
 * @returns {string[]} file names.
 */
function adbNames(platform) {
  return platform === 'win32' ? ['adb.exe', 'adb'] : ['adb'];
}

/**
 * Split a PATH-like value with the platform separator.
 * @param {string|undefined} value Raw value.
 * @param {NodeJS.Platform} platform Target platform.
 * @returns {string[]} directories.
 */
function splitPath(value, platform) {
  if (typeof value !== 'string' || value === '') return [];
  return value.split(platform === 'win32' ? ';' : ':').filter((entry) => entry !== '');
}

/**
 * Resolve the adb executable.
 * @param {{ env?: Record<string, string|undefined>, platform?: NodeJS.Platform, home?: string, exists?: (path: string) => boolean }} [options]
 * @returns {string|null} absolute or bare path, or null when unavailable.
 */
export function resolveAdb(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const names = adbNames(platform);

  /** @type {string[]} */
  const roots = [];
  if (typeof env.ADB === 'string' && env.ADB.trim() !== '') {
    const value = env.ADB.trim();
    const direct = names.some((name) => value.toLowerCase().endsWith(name));
    if (direct && exists(value)) return value;
    roots.push(value);
  }
  if (typeof env.ANDROID_HOME === 'string' && env.ANDROID_HOME.trim() !== '') roots.push(env.ANDROID_HOME.trim());
  if (typeof env.ANDROID_SDK_ROOT === 'string' && env.ANDROID_SDK_ROOT.trim() !== '') roots.push(env.ANDROID_SDK_ROOT.trim());
  const home = options.home ?? (typeof env.USERPROFILE === 'string' ? env.USERPROFILE : undefined);
  if (home !== undefined && env.LOCALAPPDATA !== undefined) roots.push(path.join(env.LOCALAPPDATA, 'Android', 'Sdk'));
  if (home !== undefined) roots.push(path.join(home, 'AppData', 'Local', 'Android', 'Sdk'));

  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, 'platform-tools', name);
      if (exists(candidate)) return candidate;
    }
  }

  for (const directory of splitPath(env.PATH ?? env.Path, platform)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}
