#!/usr/bin/env node
/**
 * Lightweight lint for the plugin repository.
 *
 * Checks every JavaScript file parses with `node --check` and scans the runtime
 * files for patterns this plugin must never use: shell execution, network access,
 * machine-specific absolute paths, and non-allowlisted client `require` calls.
 * Uses inherited stdio so it also works under the DSH file sandbox, which
 * blocks piped child stdio.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

/**
 * @param {string} dir
 * @param {string[]} result
 * @returns {string[]}
 */
function listFiles(dir, result = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry.startsWith('.tmp')) continue;
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) listFiles(full, result);
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) result.push(full);
  }
  return result;
}

/** @type {string[]} */
const problems = [];

const scriptFiles = listFiles(root);
for (const file of scriptFiles) {
  const check = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (check.status !== 0) problems.push(`${path.relative(root, file)}: syntax check failed`);
}

/** @type {Array<{ file: string, name: string, patterns: Array<[RegExp, string]> }>} */
const rules = [
  {
    file: 'index.js',
    name: 'host entry',
    patterns: [
      [/\bshell\s*:\s*true\b/, 'shell: true is forbidden; probes must use bounded spawn'],
      [/\bexecSync\s*\(/, 'execSync is forbidden; use the bounded command runner'],
      [/\bfetch\s*\(/, 'network access is forbidden'],
      [/from\s+['"]node:(?:https?|net)['"]/, 'outbound network modules are forbidden'],
      [/https?:\/\/(?!localhost)/, 'outbound network URLs are forbidden'],
      [/require\s*\(/, 'host entry must stay ESM without require()'],
      [/\sprocess\.exit\s*\(/, 'the plugin must never exit the host process'],
    ],
  },
  {
    file: 'client.js',
    name: 'client half',
    patterns: [
      [/\bdocument\./, 'client cards must not touch the DOM directly'],
      [/\bfetch\s*\(/, 'client cards must not use the network'],
      [/\bsetInterval\s*\(/, 'client cards must stay passive (no timers)'],
      [/@deepseek-ai\//, 'client half may only require react and react/jsx-runtime'],
    ],
  },
];

/** @type {string[]} */
const runtimeLibFiles = readdirSync(path.join(root, 'lib'))
  .filter((entry) => entry.endsWith('.js'))
  .map((entry) => path.join(root, 'lib', entry));
for (const file of runtimeLibFiles) {
  rules.push({
    file: path.relative(root, file),
    name: 'host lib',
    patterns: [
      [/\bshell\s*:\s*true\b/, 'shell: true is forbidden; probes must use bounded spawn'],
      [/\bexecSync\s*\(/, 'execSync is forbidden; use the bounded command runner'],
      [/\bfetch\s*\(/, 'network access is forbidden'],
      [/from\s+['"]node:(?:https?|net)['"]/, 'outbound network modules are forbidden'],
      [/https?:\/\/(?!localhost)/, 'outbound network URLs are forbidden'],
      [/require\s*\(/, 'host modules must stay ESM without require()'],
      [/\sprocess\.exit\s*\(/, 'the plugin must never exit the host process'],
    ],
  });
}

/** @param {string} relative */
function readRuntime(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

// The tool cards above the panel marker stay passive. The panel surface is the
// one sanctioned exception: it may poll the authenticated same-origin Host API
// and manage its own React state.
const clientSourceForRules = readRuntime('client.js');
const panelMarker = '// Host health panel: main column surface';
const panelIndex = clientSourceForRules.indexOf(panelMarker);
const passiveCardSource = panelIndex === -1 ? clientSourceForRules : clientSourceForRules.slice(0, panelIndex);

for (const rule of rules) {
  let text;
  try {
    text = readRuntime(rule.file);
  } catch {
    problems.push(`${rule.file}: missing file for ${rule.name} rules`);
    continue;
  }
  const scanned = rule.file === 'client.js' ? passiveCardSource : text;
  for (const [pattern, message] of rule.patterns) {
    if (pattern.test(scanned)) problems.push(`${rule.file}: ${message}`);
  }
}

// Client require allowlist: react and react/jsx-runtime only.
const clientSource = readRuntime('client.js');
const requirePattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const match of clientSource.matchAll(requirePattern)) {
  const dependency = match[1];
  if (dependency !== 'react' && dependency !== 'react/jsx-runtime') {
    problems.push(`client.js: require("${dependency}") is not allowed`);
  }
}

// The icon must keep its bytes inside the repository and under the size limit.
const iconSize = statSync(path.join(root, 'icon.svg')).size;
if (iconSize > 256 * 1024) problems.push('icon.svg: exceeds the 256 KiB display limit');

if (problems.length > 0) {
  console.error(`lint: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`lint: ok (${scriptFiles.length} JavaScript files parsed, runtime patterns clean)`);
