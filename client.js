/**
 * DeepSeek Harness host-health plugin (Web Client half).
 *
 * Registers compact, read-only tool cards for the five host-health tools. The
 * cards render plain React elements only: no first-party Harness imports, no
 * DOM writes, no data fetching, and no actions. A malformed block renders
 * `null` instead of throwing, so the conversation surface can never break.
 *
 * The generic tool card remains the fallback for any tool not registered here.
 */

window.__ModuleLoader__.load({
  id: '@darkmintis/dsh-host-health',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'host-health';

    /** Card strings; also exported as locale/en.json for display metadata. */
    const LOCALE = {
      'row.host_stats.title': 'Host stats',
      'row.host_stats.summary': 'RAM, CPU, disk, and top processes',
      'row.ports_list.title': 'Port list',
      'row.ports_list.summary': 'TCP listeners and known dev ports',
      'row.stale_dev_processes.title': 'Stale dev processes',
      'row.stale_dev_processes.summary': 'Leftover servers, emulators, and daemons',
      'row.port_kill.title': 'Port kill',
      'row.port_kill.summary': 'Free a listening port',
      'row.process_kill.title': 'Process kill',
      'row.process_kill.summary': 'Terminate one process',
      'row.preparing': 'Preparing...',
      'row.running': 'Reading host...',
      'row.failed': 'Failed',
      'row.noData': 'No data',
    };

    /** Fallback titles if the locale service is unavailable. */
    const TITLES = {
      host_stats: 'Host stats',
      ports_list: 'Port list',
      stale_dev_processes: 'Stale dev processes',
      port_kill: 'Port kill',
      process_kill: 'Process kill',
    };

    /** Fallback summaries for the collapsed row. */
    const SUMMARIES = {
      host_stats: 'RAM, CPU, disk, and top processes',
      ports_list: 'TCP listeners and known dev ports',
      stale_dev_processes: 'Leftover servers, emulators, and daemons',
      port_kill: 'Free a listening port',
      process_kill: 'Terminate one process',
    };

    const cardStyle = {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      color: 'var(--dsw-alias-label-tertiary)',
    };
    const summaryRowStyle = {
      display: 'flex',
      alignItems: 'center',
      minHeight: 24,
      fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
      lineHeight: 1.4,
      overflow: 'hidden',
    };
    const titleStyle = { flex: 'none', color: 'inherit' };
    const separatorStyle = {
      flex: 'none',
      width: 2,
      height: 2,
      borderRadius: 1,
      margin: '0 8px',
      background: 'var(--dsw-alias-label-caption)',
    };
    const summaryStyle = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      color: 'var(--dsw-alias-label-secondary)',
    };
    const errorSummaryStyle = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      color: 'var(--dsw-alias-state-error-primary)',
    };
    const bodyStyle = {
      margin: '4px 0 4px 4px',
      padding: '8px 10px',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      borderRadius: 'var(--dsw-radius-lg, 8px)',
      background: 'var(--dsw-alias-markdown-code-block)',
      color: 'var(--dsw-alias-label-secondary)',
      fontFamily: 'var(--dsw-font-family-mono, monospace)',
      fontSize: 12,
      lineHeight: 1.45,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxHeight: 280,
      overflow: 'auto',
    };

    /**
     * Translate one card string with a hard-coded English fallback.
     * @param {Record<string, any>} props
     * @param {string} key
     * @returns {string}
     */
    function tr(props, key) {
      try {
        if (props !== null && typeof props === 'object' && typeof props.t === 'function') {
          const translated = props.t(key);
          if (typeof translated === 'string' && translated !== '' && translated !== key) return translated;
        }
      } catch {
        // Locale translation is best-effort; fall through to English.
      }
      return LOCALE[key] !== undefined ? LOCALE[key] : key;
    }

    /**
     * Read raw tool arguments from a preparing/start block or a settled block.
     * @param {any} block
     * @returns {Record<string, any>}
     */
    function readArgs(block) {
      try {
        if (block === null || typeof block !== 'object') return {};
        const settled = 'kind' in block;
        const raw = settled ? block.call && block.call.argsRaw : block.argsRaw;
        if (typeof raw !== 'string' || raw === '') return {};
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    /**
     * Flatten durable result content blocks to text.
     * @param {any} block
     * @returns {string}
     */
    function resultText(block) {
      try {
        if (block === null || typeof block !== 'object' || !Array.isArray(block.content)) return '';
        const parts = [];
        for (const item of block.content) {
          if (item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
            parts.push(item.text);
          }
        }
        return parts.join('\n');
      } catch {
        return '';
      }
    }

    /**
     * @param {string} text
     * @returns {string}
     */
    function firstLine(text) {
      const value = typeof text === 'string' ? text.trim() : '';
      if (value === '') return '';
      const newline = value.indexOf('\n');
      return newline === -1 ? value : value.slice(0, newline);
    }

    /**
     * @param {string} toolName
     * @param {string} phase
     * @param {any} block
     * @returns {'preparing'|'running'|'ok'|'error'|'stopped'}
     */
    function stateOf(toolName, phase, block) {
      if (block !== null && typeof block === 'object' && 'kind' in block) {
        if (block.error && block.error.code === 'interrupted') return 'stopped';
        return block.isError ? 'error' : 'ok';
      }
      return phase === 'preparing' ? 'preparing' : 'running';
    }

    /**
     * One-line summary for the collapsed row.
     * @param {string} toolName
     * @param {string} phase
     * @param {any} block
     * @returns {string}
     */
    function summaryOf(toolName, phase, block) {
      const args = readArgs(block);
      const settled = block !== null && typeof block === 'object' && 'kind' in block;
      if (!settled) {
        if (toolName === 'port_kill' && (typeof args.port === 'number' || typeof args.port === 'string')) {
          return `port ${args.port}`;
        }
        if (toolName === 'process_kill' && (typeof args.pid === 'number' || typeof args.pid === 'string')) {
          const name = typeof args.expectedName === 'string' && args.expectedName !== '' ? ` (${args.expectedName})` : '';
          return `pid ${args.pid}${name}`;
        }
        if (toolName === 'ports_list' && Array.isArray(args.ports) && args.ports.length > 0) {
          return `extra ports ${args.ports.join(', ')}`;
        }
        return SUMMARIES[toolName] !== undefined ? SUMMARIES[toolName] : '';
      }
      const text = resultText(block);
      const first = firstLine(text);
      if (first !== '') return first;
      if (toolName === 'port_kill' && (typeof args.port === 'number' || typeof args.port === 'string')) {
        return `port ${args.port}`;
      }
      if (toolName === 'process_kill' && (typeof args.pid === 'number' || typeof args.pid === 'string')) {
        return `pid ${args.pid}`;
      }
      return SUMMARIES[toolName] !== undefined ? SUMMARIES[toolName] : '';
    }

    /**
     * Build one keyed tool-card component for a wire tool name.
     * @param {string} toolName
     * @returns {(props: Record<string, any>) => any}
     */
    function createCard(toolName) {
      return function HostHealthCard(props) {
        try {
          const phase = props !== null && typeof props === 'object' && typeof props.phase === 'string' ? props.phase : 'preparing';
          const block = props !== null && typeof props === 'object' ? props.block : undefined;
          const state = stateOf(toolName, phase, block);
          const titleKey = `row.${toolName}.title`;
          const title = tr(props, titleKey) !== titleKey ? tr(props, titleKey) : TITLES[toolName] || toolName;
          let summary = summaryOf(toolName, phase, block);
          if (state === 'preparing' && summary === '') summary = tr(props, 'row.preparing');
          else if (state === 'running' && summary === '') summary = tr(props, 'row.running');
          else if (state === 'stopped') summary = `${tr(props, 'row.failed')}: interrupted`;
          else if (state === 'error' && firstLine(resultText(block)) === '') summary = tr(props, 'row.failed');
          const body = state === 'preparing' ? '' : resultText(block);
          const summaryNode = h(
            'span',
            { style: state === 'error' ? errorSummaryStyle : summaryStyle },
            summary,
          );
          if (body === '') {
            return h(
              'div',
              { style: cardStyle, 'data-tool': toolName, 'data-state': state },
              h(
                'div',
                { style: summaryRowStyle },
                h('span', { style: titleStyle }, title),
                h('span', { style: separatorStyle, 'aria-hidden': true }),
                summaryNode,
              ),
            );
          }
          return h(
            'div',
            { style: cardStyle, 'data-tool': toolName, 'data-state': state },
            h(
              'details',
              { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
              h(
                'summary',
                { style: summaryRowStyle },
                h('span', { style: titleStyle }, title),
                h('span', { style: separatorStyle, 'aria-hidden': true }),
                summaryNode,
              ),
              h('pre', { style: bodyStyle, tabIndex: 0 }, body),
            ),
          );
        } catch {
          return null;
        }
      };
    }

    // ------------------------------------------------------------------
    // Host health panel: main column surface + sidebar entry
    // ------------------------------------------------------------------

    /** Panel id shared by the `main` key and the `sidebar.panellist` entry. */
    const PANEL_ID = 'host-health';
    /** Host HTTP API prefix, resolved against the page base URL. */
    const API_PREFIX = 'dsh-host-health/api/';
    /** Live stat polling cadence for the composer-dock pills. */
    const STATS_POLL_MS = 2_500;

    /** Palette; theme tokens only. */
    const HP = {
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      ok: 'var(--dsw-alias-state-success-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
      overlay: 'var(--dsw-alias-bg-overlay)',
    };

    /**
     * Base URL for the Host's panel routes. The page-relative form is the
     * correct one everywhere: a normal Web page resolves it against its own
     * HTTP origin, and the desktop shell page (`dsh-app://app`) forwards those
     * same-origin requests to the owned Host with its authentication cookie
     * injected. A direct loopback URL would be cross-origin and blocked.
     * @returns {string} document base URL.
     */
    function hpApiBase() {
      return document.baseURI;
    }
    /**
     * @param {string} endpoint Route under the plugin prefix.
     * @returns {string} absolute URL.
     */
    function hpApiUrl(endpoint) {
      return new URL(API_PREFIX + endpoint, hpApiBase()).href;
    }

    /**
     * Fetch one JSON payload with same-origin credentials.
     * @param {string} url Absolute URL.
     * @param {{ method?: string, body?: unknown }} [options] Request options.
     * @returns {Promise<Record<string, any>>} parsed payload.
     */
    async function hpFetchJson(url, options = {}) {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        credentials: 'include',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Host API ${response.status}: not authorized for this page`);
      }
      if (payload === null) throw new Error(`Host API ${response.status}: no JSON body`);
      if (payload.ok === false) throw new Error(typeof payload.error === 'string' ? payload.error : `Host API ${response.status}`);
      return payload;
    }

    /**
     * Format a byte count.
     * @param {number} bytes Byte count.
     * @returns {string} human size.
     */
    function hpBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
    }

    /**
     * Format seconds as a compact duration.
     * @param {number} seconds Seconds.
     * @returns {string} duration.
     */
    function hpUptime(seconds) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '—';
      const days = Math.floor(seconds / 86_400);
      const hours = Math.floor((seconds % 86_400) / 3_600);
      const minutes = Math.floor((seconds % 3_600) / 60);
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m`;
    }

    /**
     * @param {number} value Number.
     * @param {number} [digits] Fixed digits.
     * @returns {string} formatted or an em dash.
     */
    function hdFixed(value, digits = 0) {
      return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
    }

    /**
     * Two-digit fixed reading so the pill never changes width between single
     * and double digit values (05%, 96%).
     * @param {number} value Number.
     * @returns {string} zero-padded reading.
     */
    function hpPad(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return String(Math.max(0, Math.min(99, Math.round(value)))).padStart(2, '0');
    }

    /**
     * Alert tone for a 0-100 percentage; undefined when healthy.
     * @param {number} percent Value.
     * @param {number} warn Warn threshold.
     * @param {number} danger Danger threshold.
     * @returns {string|undefined} theme color.
     */
    function hdTone(percent, warn, danger) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined;
      if (percent >= danger) return HP.err;
      if (percent >= warn) return HP.warn;
      return undefined;
    }

    // ------------------------------------------------------------------
    // Shared health state: both pills and the dialog layer subscribe to one
    // poller, so the dock stays a single, cheap data source.
    // ------------------------------------------------------------------

    /** @type {{ stats: Record<string, any>|null, error: string|null, open: 'host'|'devices'|null, anchor: DOMRect|null }} */
    const healthState = { stats: null, error: null, open: null, anchor: null };
    /** @type {Set<() => void>} */
    const healthListeners = new Set();
    let healthStarted = false;
    /** @type {ReturnType<typeof setInterval>|null} */
    let healthTimer = null;

    function healthNotify() {
      for (const listener of healthListeners) listener();
    }

    /**
     * Merge a patch into the shared state and re-render every subscriber.
     * @param {Partial<typeof healthState>} patch State patch.
     * @returns {void}
     */
    function healthUpdate(patch) {
      Object.assign(healthState, patch);
      healthNotify();
    }

    /** Fetch one snapshot and publish it. */
    async function healthLoad() {
      try {
        const payload = await hpFetchJson(hpApiUrl('stats'));
        healthUpdate({ stats: payload.value ?? null, error: null });
      } catch (cause) {
        healthUpdate({ error: cause instanceof Error ? cause.message : String(cause) });
      }
    }

    /** Start the shared poller exactly once. */
    function healthStart() {
      if (healthStarted) return;
      healthStarted = true;
      healthLoad();
      healthTimer = setInterval(healthLoad, STATS_POLL_MS);
    }

    /**
     * Subscribe a component to the shared health state.
     * @returns {typeof healthState} live state (mutated in place).
     */
    function useHealth() {
      const { useState, useEffect } = React;
      const [, setTick] = useState(0);
      useEffect(() => {
        const listener = () => setTick((value) => value + 1);
        healthListeners.add(listener);
        healthStart();
        return () => healthListeners.delete(listener);
      }, []);
      return healthState;
    }

    // ------------------------------------------------------------------
    // Official-style composer-dock pills: ghost pill + portaled-style dialog
    // rendered by a sibling frame-overlay entry (the composer dock cannot host
    // fixed overlays itself, and this half may not import react-dom).
    // ------------------------------------------------------------------

    /** Ghost pill, matching the shipped session-statistics pills. */
    const PILL = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      minWidth: 0,
      maxWidth: '100%',
      padding: '1px 8px',
      borderRadius: '6px',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '20px',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      WebkitAppRegion: 'no-drag',
    };

    /** Dialog chrome, matching the shipped stat dialogs. */
    const HS = {
      panel: {
        position: 'fixed',
        zIndex: 2101,
        boxSizing: 'border-box',
        width: 'max-content',
        minWidth: 'min(320px, calc(100vw - 24px))',
        maxWidth: 'min(440px, calc(100vw - 24px))',
        padding: '16px',
        borderRadius: 'var(--dsw-radius-lg, 12px)',
        border: 0,
        background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-overlay))',
        backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
        boxShadow: 'var(--dsw-elevation-prominent, none)',
        '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
        color: HP.sub,
        fontSize: '12px',
        lineHeight: '18px',
        maxHeight: 'min(60vh, 520px)',
        overflowY: 'auto',
        pointerEvents: 'auto',
        cursor: 'default',
      },
      title: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px', marginBottom: '8px', color: HP.text, fontWeight: 500 },
      titleLabel: { display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      titleValue: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      rule: { borderTop: `0.5px solid ${HP.border2}`, marginBottom: '10px' },
      dl: { display: 'grid', gridTemplateColumns: 'minmax(76px, auto) minmax(0, 1fr)', gap: '6px 16px', margin: 0 },
      dt: { margin: 0, color: HP.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      dd: { margin: 0, textAlign: 'right', color: HP.text, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
      empty: { color: HP.sub },
    };

    /**
     * Line icon shared by the pills and dialog titles.
     * @param {'gauge'|'phone'} kind Icon kind.
     * @returns {any} svg element.
     */
    function healthIcon(kind) {
      const shared = {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { flex: 'none' },
      };
      if (kind === 'phone') {
        return h('svg', shared, h('rect', { x: '7', y: '2', width: '10', height: '20', rx: '2' }), h('line', { x1: '11', y1: '18', x2: '13', y2: '18' }));
      }
      return h(
        'svg',
        shared,
        h('path', { d: 'M4 18a8 8 0 1 1 16 0' }),
        h('path', { d: 'M12 18l3-5' }),
        h('circle', { cx: '12', cy: '18', r: '1.2' }),
      );
    }

    /**
     * One label/value row in the dialog grid.
     * @param {string} label Row label.
     * @param {string} value Row value.
     * @param {string|undefined} [tone] Optional alert color.
     * @param {string} [key] React key override (device serials repeat labels).
     * @returns {any} React fragment with a dt/dd pair.
     */
    function hdRow(label, value, tone, key) {
      return h(
        React.Fragment,
        { key: key ?? label },
        h('dt', { style: HS.dt, title: label }, label),
        h('dd', { style: tone === undefined ? HS.dd : { ...HS.dd, color: tone } }, value),
      );
    }

    /**
     * Build the "Host health" dialog rows from one stats snapshot.
     * @param {Record<string, any>|null} stats Snapshot.
     * @returns {Array<any>|null} rows, or null when nothing is known yet.
     */
    function hostDialogRows(stats) {
      if (stats === null || typeof stats !== 'object') return null;
      const host = stats.host !== null && typeof stats.host === 'object' ? stats.host : {};
      const memory = stats.memory !== null && typeof stats.memory === 'object' ? stats.memory : {};
      const cpu = stats.cpu !== null && typeof stats.cpu === 'object' ? stats.cpu : {};
      const volumes = Array.isArray(stats.volumes) ? stats.volumes : [];
      const perCore = Array.isArray(cpu.perCore) ? cpu.perCore : [];
      const peakCore = perCore.reduce((peak, core) => Math.max(peak, typeof core.percent === 'number' ? core.percent : 0), 0);
      /** @type {Array<any>} */
      const rows = [];
      if (typeof cpu.percent === 'number') {
        rows.push(hdRow('CPU', `${hdFixed(cpu.percent)}%${perCore.length > 0 ? ` · peak ${hdFixed(peakCore)}%` : ''}`));
      }
      if (typeof memory.usedPercent === 'number') {
        rows.push(hdRow('Memory', `${hdFixed(memory.usedPercent)}% · ${hpBytes(memory.usedBytes ?? 0)} / ${hpBytes(memory.totalBytes ?? 0)}`, hdTone(memory.usedPercent, 80, 92)));
      }
      if (typeof memory.committedBytes === 'number') rows.push(hdRow('Committed', hpBytes(memory.committedBytes)));
      for (const volume of volumes) {
        if (typeof volume.usedPercent !== 'number') continue;
        rows.push(hdRow(`Disk ${String(volume.path ?? '?')}`, `${hdFixed(volume.usedPercent)}% · ${hpBytes(volume.freeBytes ?? 0)} free`, hdTone(volume.usedPercent, 85, 95)));
      }
      if (typeof host.processCount === 'number') rows.push(hdRow('Processes', String(host.processCount)));
      if (typeof host.uptimeSeconds === 'number') rows.push(hdRow('Uptime', hpUptime(host.uptimeSeconds)));
      const topCpu = Array.isArray(stats.topCpu) ? stats.topCpu : [];
      if (topCpu.length > 0) {
        rows.push(
          hdRow(
            'Top CPU',
            topCpu
              .slice(0, 1)
              .map((process) => `${String(process.name ?? '?')} ${hdFixed(typeof process.cpuPercent === 'number' ? process.cpuPercent : 0)}%`)
              .join(' · '),
          ),
        );
      }
      const topRam = Array.isArray(stats.topRam) ? stats.topRam : [];
      if (topRam.length > 0) {
        rows.push(
          hdRow(
            'Top RAM',
            topRam
              .slice(0, 1)
              .map((process) => `${String(process.name ?? '?')} ${hpBytes((typeof process.ramMb === 'number' ? process.ramMb : 0) * 1024 * 1024)}`)
              .join(' · '),
          ),
        );
      }
      return rows.length > 0 ? rows : null;
    }

    /**
     * Build the "Devices" dialog rows from the connected-Android list.
     * @param {Record<string, any>|null} stats Snapshot.
     * @returns {Array<any>|null} rows, or null when no device is connected.
     */
    function deviceDialogRows(stats) {
      const mobiles = stats !== null && typeof stats === 'object' && Array.isArray(stats.mobiles) ? stats.mobiles : [];
      if (mobiles.length === 0) return null;
      const multiple = mobiles.length > 1;
      /** @type {Array<any>} */
      const rows = [];
      for (const device of mobiles) {
        const memory = device.memory !== null && typeof device.memory === 'object' ? device.memory : null;
        const storage = device.storage !== null && typeof device.storage === 'object' ? device.storage : null;
        const name = String(device.model ?? device.serial);
        const prefix = multiple ? `${name} ` : '';
        if (!multiple) rows.push(hdRow('Device', name, undefined, `device:${String(device.serial)}`));
        if (memory !== null && typeof memory.usedPercent === 'number') {
          rows.push(
            hdRow(`${prefix}RAM`, `${hdFixed(memory.usedPercent)}% · ${hpBytes(memory.usedBytes ?? 0)} / ${hpBytes(memory.totalBytes ?? 0)}`, undefined, `ram:${String(device.serial)}`),
          );
        }
        if (storage !== null && typeof storage.usedPercent === 'number') {
          rows.push(hdRow(`${prefix}Disk`, `${hdFixed(storage.usedPercent)}% · ${hpBytes(storage.freeBytes ?? 0)} free`, undefined, `disk:${String(device.serial)}`));
        }
        if (typeof device.cpuPercent === 'number') {
          rows.push(hdRow(`${prefix}CPU`, `${hdFixed(device.cpuPercent)}%`, undefined, `cpu:${String(device.serial)}`));
        }
        if (typeof device.androidVersion === 'string') {
          rows.push(hdRow(`${prefix}Android`, `${device.androidVersion}${typeof device.sdk === 'number' ? ` · SDK ${device.sdk}` : ''}`, undefined, `android:${String(device.serial)}`));
        }
      }
      return rows.length > 0 ? rows : null;
    }

    /**
     * One ghost pill matching the shipped stat pills.
     * @param {{ kind: string, icon: 'gauge'|'phone', label: string, active: boolean, title: string, buttonRef?: any, onClick: () => void }} props Pill props.
     * @returns {any} button element.
     */
    function HealthPill(props) {
      const { useState } = React;
      const [hover, setHover] = useState(false);
      const lit = props.active === true || hover === true;
      return h(
        'button',
        {
          type: 'button',
          ref: props.buttonRef,
          'data-host-health-pill': props.kind,
          'aria-haspopup': 'dialog',
          'aria-expanded': props.active === true,
          title: props.title,
          onClick: props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: { ...PILL, background: lit ? 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))' : 'transparent', color: lit ? HP.sub : 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))' },
        },
        healthIcon(props.icon),
        h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, props.label),
      );
    }

    /**
     * Host health pill: CPU and memory at a glance.
     * @returns {any} pill element.
     */
    function HostHealthPill() {
      const { useRef } = React;
      const health = useHealth();
      const buttonRef = useRef(null);
      const stats = health.stats;
      const cpuPercent = stats !== null && typeof stats === 'object' && stats.cpu !== null && typeof stats.cpu === 'object' && typeof stats.cpu.percent === 'number' ? stats.cpu.percent : null;
      const memPercent =
        stats !== null && typeof stats === 'object' && stats.memory !== null && typeof stats.memory === 'object' && typeof stats.memory.usedPercent === 'number'
          ? stats.memory.usedPercent
          : null;
      const label =
        health.error !== null
          ? 'Host offline'
          : cpuPercent === null && memPercent === null
            ? 'CPU — · RAM —'
            : `CPU ${cpuPercent === null ? '—' : hpPad(cpuPercent)}% · RAM ${memPercent === null ? '—' : hpPad(memPercent)}%`;
      const active = health.open === 'host';
      const onClick = () => {
        const element = buttonRef.current;
        const anchor = element !== null && element !== undefined && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
        healthUpdate({ open: active ? null : 'host', anchor });
      };
      return h(HealthPill, { kind: 'host', icon: 'gauge', label, active, title: 'Host health', buttonRef, onClick });
    }

    /**
     * Connected-devices pill; hidden when no Android device is attached.
     * @returns {any|null} pill element or null.
     */
    function HostDevicesPill() {
      const { useRef } = React;
      const health = useHealth();
      const buttonRef = useRef(null);
      const stats = health.stats;
      const mobiles = stats !== null && typeof stats === 'object' && Array.isArray(stats.mobiles) ? stats.mobiles : [];
      if (mobiles.length === 0) return null;
      const label = `${mobiles.length} device${mobiles.length === 1 ? '' : 's'}`;
      const active = health.open === 'devices';
      const onClick = () => {
        const element = buttonRef.current;
        const anchor = element !== null && element !== undefined && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
        healthUpdate({ open: active ? null : 'devices', anchor });
      };
      return h(HealthPill, { kind: 'devices', icon: 'phone', label, active, title: 'Connected devices', buttonRef, onClick });
    }

    /**
     * Frame-overlay dialog layer. The composer dock cannot host a fixed
     * overlay, so this sibling entry draws the dialog above every column.
     * @returns {any|null} dialog element or null while closed.
     */
    function HealthLayer() {
      const { useState, useRef, useEffect } = React;
      const health = useHealth();
      const dialogRef = useRef(null);
      const [pos, setPos] = useState(null);
      const open = health.open;

      useEffect(() => {
        if (open === null) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          const dialog = dialogRef.current;
          if (dialog !== null && dialog !== undefined && typeof dialog.contains === 'function' && dialog.contains(target) === true) return;
          if (target !== null && typeof target === 'object' && typeof target.closest === 'function' && target.closest('[data-host-health-pill]') !== null) return;
          healthUpdate({ open: null });
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') healthUpdate({ open: null });
        };
        const onScroll = () => healthUpdate({ open: null });
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('scroll', onScroll, true);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
          document.removeEventListener('scroll', onScroll, true);
        };
      }, [open]);

      useEffect(() => {
        if (open === null) {
          setPos(null);
          return undefined;
        }
        const place = () => {
          const panel = dialogRef.current;
          const anchor = health.anchor;
          if (panel === null || panel === undefined || anchor === null || typeof anchor !== 'object') return;
          const margin = 12;
          const gap = 8;
          const width = typeof panel.offsetWidth === 'number' && panel.offsetWidth > 0 ? panel.offsetWidth : 320;
          const height = typeof panel.offsetHeight === 'number' && panel.offsetHeight > 0 ? panel.offsetHeight : 0;
          const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth;
          const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
          const left = Math.max(margin, Math.min(typeof anchor.left === 'number' ? anchor.left : margin, viewportWidth - width - margin));
          let bottom = Math.max(margin, viewportHeight - (typeof anchor.top === 'number' ? anchor.top : viewportHeight - 80) + gap);
          if (height > 0 && viewportHeight - bottom - height < margin) bottom = Math.max(margin, viewportHeight - margin - height);
          setPos({ left, bottom });
        };
        place();
        if (typeof window === 'undefined') return undefined;
        window.addEventListener('resize', place);
        return () => window.removeEventListener('resize', place);
      }, [open, health.anchor]);

      if (open === null) return null;
      const isHost = open === 'host';
      const stats = health.stats;
      const rows = isHost ? hostDialogRows(stats) : deviceDialogRows(stats);
      const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
      const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth;
      const anchor = health.anchor;
      const anchorTop = anchor !== null && typeof anchor === 'object' && typeof anchor.top === 'number' ? anchor.top : viewportHeight - 80;
      const anchorLeft = anchor !== null && typeof anchor === 'object' && typeof anchor.left === 'number' ? anchor.left : 12;
      const estimatedWidth = 320;
      const left = pos !== null ? pos.left : Math.max(12, Math.min(anchorLeft, viewportWidth - estimatedWidth - 12));
      const bottom = pos !== null ? pos.bottom : Math.max(12, Math.min(viewportHeight - 12, viewportHeight - anchorTop + 8));
      const host = stats !== null && typeof stats === 'object' && stats.host !== null && typeof stats.host === 'object' ? stats.host : null;
      const titleValue = isHost ? (host !== null && typeof host.uptimeSeconds === 'number' ? hpUptime(host.uptimeSeconds) : '—') : `${(stats !== null && typeof stats === 'object' && Array.isArray(stats.mobiles) ? stats.mobiles : []).length} connected`;

      return h(
        'div',
        { 'data-host-health-layer': 'open', style: { position: 'fixed', inset: 0, zIndex: 2100, pointerEvents: 'none' } },
        h(
          'div',
          { ref: dialogRef, role: 'dialog', 'aria-label': isHost ? 'Host health' : 'Devices', style: { ...HS.panel, left: `${left}px`, bottom: `${bottom}px` } },
          h(
            'div',
            { style: HS.title },
            h('span', { style: HS.titleLabel }, healthIcon(isHost ? 'gauge' : 'phone'), isHost ? 'Host health' : 'Devices'),
            h('span', { style: HS.titleValue }, titleValue),
          ),
          h('div', { style: HS.rule, 'aria-hidden': true }),
          rows !== null
            ? h('dl', { style: HS.dl, 'data-host-health-rows': isHost ? 'host' : 'devices' }, rows)
            : h('div', { style: HS.empty }, health.error !== null ? health.error : 'Waiting for the first host snapshot…'),
        ),
      );
    }

    const cards = ['host_stats', 'ports_list', 'stale_dev_processes', 'port_kill', 'process_kill'];

    return {
      inject: ['slots'],
      /**
       * Register the read-only cards; display strings go through the locale
       * service when it is composed.
       * @param {Record<string, any>} ctx
       */
      apply(ctx) {
        try {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
          if (locale && typeof locale.register === 'function') {
            ctx.effect(() => locale.register(NS, { en: LOCALE }), 'host-health: locale');
          }
        } catch {
          // Locale is optional; the cards keep their English fallbacks.
        }
        // Health pills dock beside the official session-statistics pills, so
        // they sit in the same row as "N turns M steps" and "Cache hit". Their
        // dialog is drawn by a frame-overlay sibling because the composer dock
        // cannot host fixed overlays and this half may not import react-dom.
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'host-health', order: 2, label: 'Host health' },
            HostHealthPill,
          ),
        );
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'host-devices', order: 3, label: 'Connected devices' },
            HostDevicesPill,
          ),
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'host-health-dialog', order: 110, label: 'Host health details' },
            HealthLayer,
          ),
        );

        for (const key of cards) {
          ctx.slots.inject('tool.call.toolview', () =>
            ctx.slots.register(
              { name: 'tool.call.toolview', key, locale: NS },
              createCard(key),
            ),
          );
        }
      },
    };
  },
});
