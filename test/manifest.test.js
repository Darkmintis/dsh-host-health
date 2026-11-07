import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { TOOL_NAMES } from '../lib/constants.js';

const root = path.resolve(import.meta.dirname, '..');

/** @param {string} relative @returns {string} */
function read(relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

/** @param {string} relative @returns {boolean} */
function exists(relative) {
  return existsSync(path.join(root, relative));
}

const manifest = JSON.parse(read('package.json'));

test('manifest describes the published DSH profile bundle', () => {
  assert.equal(manifest.name, '@darkmintis/dsh-host-health');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.main, 'index.js');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.1');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.equal(manifest.dsh.client.immediately, true);
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'));
  assert.match(manifest.repository.url, /dsh-host-health\.git$/);
  for (const keyword of ['dsh', 'dsh-plugin', 'deepseek-harness', 'monitoring', 'ports']) {
    assert.ok(manifest.keywords.includes(keyword), `keyword ${keyword}`);
  }
});

test('exports expose the runtime, client, locale, and icon entries', () => {
  assert.equal(manifest.exports['.'], './index.js');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.equal(manifest.exports['./icon'], './icon.svg');
});

test('the bundle patch inserts one row with the package name', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, /^- insert:/m);
  assert.match(patch, /id: dsh-host-health/);
  assert.match(patch, /name: '@darkmintis\/dsh-host-health'/);
  assert.match(patch, /config: \{\}/);
  assert.equal((patch.match(/- insert:/g) ?? []).length, 1);
});

test('locale metadata is complete and sentence case', () => {
  const locale = JSON.parse(read('locale/en.json'));
  assert.equal(typeof locale.meta.title, 'string');
  assert.equal(typeof locale.meta.description, 'string');
  assert.ok(locale.meta.title.length > 0 && locale.meta.title.length < 60);
  assert.ok(locale.meta.description.length > 20 && locale.meta.description.length < 200);
  assert.match(locale.meta.title, /^Host health$/);
  for (const tool of TOOL_NAMES) {
    assert.equal(typeof locale[`row.${tool}.title`], 'string', `locale row title for ${tool}`);
    assert.equal(typeof locale[`row.${tool}.summary`], 'string', `locale row summary for ${tool}`);
  }
});

test('the icon is an original SVG within limits', () => {
  const icon = read('icon.svg');
  assert.ok(icon.trimStart().startsWith('<svg'));
  assert.ok(Buffer.byteLength(icon, 'utf8') <= 256 * 1024);
  assert.match(icon, /viewBox="0 0 64 64"/);
  assert.match(icon, /aria-label=/);
  assert.doesNotMatch(icon, /<script/i);
});

test('every runtime file is present and covered by the files array', () => {
  const runtimeFiles = [
    'index.js',
    'client.js',
    'cordis.patch.yml',
    'icon.svg',
    ...readdirSync(path.join(root, 'lib')).filter((entry) => entry.endsWith('.js')).map((entry) => `lib/${entry}`),
    ...readdirSync(path.join(root, 'locale')).filter((entry) => entry.endsWith('.json')).map((entry) => `locale/${entry}`),
  ];
  /** @param {string} pattern @param {string} file */
  const matches = (pattern, file) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`).test(file);
  };
  for (const file of runtimeFiles) {
    assert.equal(exists(file), true, `${file} exists`);
    assert.ok(manifest.files.some((pattern) => matches(pattern, file)), `${file} is packed`);
  }
});

test('documentation set is complete and README covers required sections', () => {
  for (const file of ['README.md', 'AGENTS.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'LICENSE']) {
    assert.equal(exists(file), true, `${file} exists`);
    assert.ok(statSync(path.join(root, file)).size > 100, `${file} is not empty`);
  }
  const readme = read('README.md');
  for (const heading of ['## Pitch', '## Requirements', '## Install', '## Security and permissions', '## Tool reference', '## Troubleshooting', '## Development', '## License']) {
    assert.ok(readme.includes(heading), `README has ${heading}`);
  }
  assert.match(readme, /install_bundle/);
  assert.match(readme, /cordis\.patch\.yml/);
  assert.match(readme, /npm publish/);
  assert.match(readme, /approval/i);
  assert.match(readme, /screenshot/i);
  const changelog = read('CHANGELOG.md');
  assert.match(changelog, /## \[0\.1\.0\]/);
  assert.match(changelog, /Keep a Changelog/i);
  const agents = read('AGENTS.md');
  assert.match(agents, /read-only/i);
  assert.match(agents, /approval/i);
  assert.match(agents, /re-verif/i);
  assert.match(agents, /telemetry/i);
});

test('repository text files contain no machine-specific absolute paths or secrets', () => {
  /** @type {string[]} */
  const files = [];
  /** @param {string} relative */
  const collect = (relative) => {
    const full = path.join(root, relative);
    if (!exists(relative)) return;
    const stats = statSync(full);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(full)) {
        if (['node_modules', '.git', '.tmp', 'coverage'].includes(entry)) continue;
        collect(path.join(relative, entry));
      }
      return;
    }
    if (/\.(js|mjs|json|yml|yaml|md|svg|txt)$/.test(relative)) files.push(relative);
  };
  for (const entry of readdirSync(root)) collect(entry);
  const machinePath = /(?:[A-Za-z]:\\Users\\|[A-Za-z]:\/Users\/|D:\\Projects\\|C:\\Projects\\)/;
  const secret = /(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})/;
  for (const file of files) {
    const content = readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(content, machinePath, `${file} has no machine-specific path`);
    assert.doesNotMatch(content, secret, `${file} has no credential-like string`);
  }
  assert.ok(files.length > 20, 'scanned the repository files');
});

test('package-lock.json is committed for reproducible CI installs', () => {
  assert.equal(exists('package-lock.json'), true);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.name, '@darkmintis/dsh-host-health');
  assert.equal(lock.lockfileVersion >= 3, true);
});

test('CI workflow pins Node 24 and runs the full gate', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /npm ci/);
  for (const script of ['npm run typecheck', 'npm run lint', 'npm test', 'npm run build']) {
    assert.ok(workflow.includes(script), `workflow runs ${script}`);
  }
});
