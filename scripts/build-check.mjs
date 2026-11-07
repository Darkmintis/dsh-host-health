#!/usr/bin/env node
/**
 * Build/package readiness check.
 *
 * This is a plain static analysis script (no bundler needed): it verifies the
 * bundle manifest, patch, exports, locale metadata, icon, client artifact
 * contract, and the absence of machine-specific absolute paths or secrets.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

/** @type {string[]} */
const problems = [];
/** @type {string[]} */
const checks = [];

/**
 * @param {boolean} condition
 * @param {string} message
 */
function check(condition, message) {
  checks.push(message);
  if (!condition) problems.push(message);
}

/**
 * @param {string} relative
 * @returns {string}
 */
function text(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

/**
 * @param {string} relative
 * @returns {boolean}
 */
function exists(relative) {
  try {
    statSync(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

const manifest = JSON.parse(text('package.json'));

check(manifest.name === '@darkmintis/dsh-host-health', 'package name is @darkmintis/dsh-host-health');
check(manifest.version === '0.1.0', 'package version is 0.1.0');
check(manifest.type === 'module', 'package is ESM ("type": "module")');
check(manifest.main === 'index.js', 'package main is index.js');
check(manifest.license === 'MIT', 'package license is MIT');
check(typeof manifest.repository?.url === 'string' && manifest.repository.url.includes('dsh-host-health'), 'repository URL is declared');
check(
  Array.isArray(manifest.keywords) && ['dsh', 'dsh-plugin', 'deepseek-harness'].every((keyword) => manifest.keywords.includes(keyword)),
  'keywords include dsh, dsh-plugin, deepseek-harness',
);

const exportsMap = manifest.exports ?? {};
check(exportsMap['.'] === './index.js', 'exports "." points at index.js');
check(exportsMap['./client'] === './client.js', 'exports "./client" points at client.js');
check(exportsMap['./locale/*.json'] === './locale/*.json', 'exports "./locale/*.json"');
check(exportsMap['./icon'] === './icon.svg', 'exports "./icon" points at icon.svg');

check(manifest.engines?.dsh === '>=0.2.2-rc.1', 'engines.dsh declares the DSH requirement');
check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch is declared');
check(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform is web');
check(manifest.dsh?.client?.immediately === true, 'dsh.client.immediately is true');
check(
  Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'),
  'dsh.client.inject includes the conversation UI dependency',
);

/** Simple glob match supporting a single `*` segment. @param {string} pattern @param {string} file */
function matchesFiles(pattern, file) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(file);
}

const runtimeFiles = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  ...readdirSync(path.join(root, 'lib')).filter((entry) => entry.endsWith('.js')).map((entry) => `lib/${entry}`),
  ...readdirSync(path.join(root, 'locale')).filter((entry) => entry.endsWith('.json')).map((entry) => `locale/${entry}`),
];
/** @type {string[]} */
const filesList = Array.isArray(manifest.files) ? /** @type {string[]} */ (manifest.files) : [];
for (const file of runtimeFiles) {
  check(exists(file), `runtime file exists: ${file}`);
  check(filesList.some((pattern) => matchesFiles(pattern, file)), `runtime file is listed in package.json files: ${file}`);
}

const patch = text('cordis.patch.yml');
check(patch.includes('- insert:'), 'cordis.patch.yml has an insert row');
check(patch.includes('id: dsh-host-health'), 'cordis.patch.yml row id is dsh-host-health');
check(patch.includes("name: '@darkmintis/dsh-host-health'"), 'cordis.patch.yml plugin name matches the package');

const locale = JSON.parse(text('locale/en.json'));
check(typeof locale.meta?.title === 'string' && locale.meta.title.length > 0, 'locale meta.title is present');
check(
  typeof locale.meta?.description === 'string' && locale.meta.description.length > 0,
  'locale meta.description is present',
);
check(/^[A-Z][^.!?]*[.!]?$/.test(locale.meta.title), 'locale meta.title is sentence case');
check(locale['row.host_stats.title'] === 'Host stats', 'locale ships card strings');

const icon = text('icon.svg');
check(icon.trimStart().startsWith('<svg'), 'icon.svg is an SVG document');
check(Buffer.byteLength(icon, 'utf8') <= 256 * 1024, 'icon.svg is under 256 KiB');
check(icon.includes('aria-label='), 'icon.svg carries an accessible label');

const client = text('client.js');
check(client.includes("id: '@darkmintis/dsh-host-health'"), 'client module id matches the package name');
check(client.includes('window.__ModuleLoader__.load'), 'client uses the module loader');
for (const tool of ['host_stats', 'ports_list', 'stale_dev_processes', 'port_kill', 'process_kill']) {
  check(client.includes(`'${tool}'`), `client registers a read-only card for ${tool}`);
}
const clientRequires = [...client.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
check(
  clientRequires.length > 0 && clientRequires.every((dependency) => dependency === 'react' || dependency === 'react/jsx-runtime'),
  'client requires only react and react/jsx-runtime',
);

const entry = await import(pathToFileURL(path.join(root, 'index.js')).href);
check(typeof entry.apply === 'function', 'index.js exports apply(ctx, config)');
check(Array.isArray(entry.inject) && entry.inject.includes('tools'), 'index.js declares inject = [tools]');
check(typeof entry.name === 'string' && entry.name === manifest.name, 'index.js exports the plugin name');

// Repository hygiene: no machine-specific absolute paths or obvious secrets.
const scanRoots = ['index.js', 'client.js', 'lib', 'scripts', 'test', 'locale', 'cordis.patch.yml', 'README.md', 'AGENTS.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'package.json'];
const machinePath = /(?:[A-Za-z]:\\Users\\|[A-Za-z]:\/Users\/|D:\\Projects\\|C:\\Projects\\)/;
const secretPatterns = [/sk-[A-Za-z0-9]{16,}/, /ghp_[A-Za-z0-9]{20,}/, /AKIA[0-9A-Z]{16}/];
/** @type {string[]} */
const scanFiles = [];
/** @param {string} relative */
function collect(relative) {
  const full = path.join(root, relative);
  if (!exists(relative)) return;
  const stats = statSync(full);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(full)) collect(path.join(relative, entry));
    return;
  }
  if (/\.(js|mjs|json|yml|yaml|md|svg)$/.test(relative)) scanFiles.push(relative);
}
for (const relative of scanRoots) collect(relative);
for (const file of scanFiles) {
  const content = text(file);
  if (machinePath.test(content)) problems.push(`${file}: contains a machine-specific absolute path`);
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) problems.push(`${file}: contains a credential-like string`);
  }
}

if (problems.length > 0) {
  console.error(`build-check: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`build-check: ok (${checks.filter((_, index) => index >= 0).length} checks, ${runtimeFiles.length} runtime files, ${scanFiles.length} files scanned for paths/secrets)`);
