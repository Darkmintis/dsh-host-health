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
    /** Overview polling cadence while the panel is open. */
    const STATS_POLL_MS = 2_500;

    /** Panel palette; theme tokens only. */
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
    const HP_MONO = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';
    const HP_SMALL = '11.5px';

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

    /** Panel layout constants. */
    const HPP = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px', height: '100%', minHeight: 0, overflow: 'auto', background: HP.base, color: HP.text },
      header: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600 },
      sub: { color: HP.sub, fontSize: HP_SMALL },
      tabs: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
      toolbar: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      button: { font: 'inherit', fontSize: HP_SMALL, padding: '4px 9px', borderRadius: '6px', border: `1px solid ${HP.border2}`, background: HP.layer2, color: HP.text, cursor: 'pointer' },
      buttonPrimary: { font: 'inherit', fontSize: HP_SMALL, padding: '4px 9px', borderRadius: '6px', border: `1px solid ${HP.brand}`, background: HP.layer1, color: HP.brand, cursor: 'pointer', fontWeight: 600 },
      buttonDanger: { font: 'inherit', fontSize: HP_SMALL, padding: '2px 7px', borderRadius: '6px', border: `1px solid ${HP.err}`, background: HP.layer1, color: HP.err, cursor: 'pointer' },
      card: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', borderRadius: '8px', border: `1px solid ${HP.border1}`, background: HP.layer1, minWidth: 0 },
      grid: { display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' },
      barOuter: { height: '8px', borderRadius: '999px', background: HP.layer2, overflow: 'hidden', border: `1px solid ${HP.border1}` },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: HP_SMALL },
      th: { textAlign: 'left', padding: '3px 6px', color: HP.sub, borderBottom: `1px solid ${HP.border1}`, fontWeight: 600 },
      td: { padding: '3px 6px', borderBottom: `1px solid ${HP.border1}`, color: HP.text, verticalAlign: 'top' },
      mono: { fontFamily: HP_MONO, fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      toast: (tone) => ({ padding: '6px 10px', borderRadius: '6px', border: `1px solid ${tone === 'error' ? HP.err : HP.border2}`, color: tone === 'error' ? HP.err : HP.text, background: HP.layer1, fontSize: HP_SMALL, whiteSpace: 'pre-wrap' }),
      error: { padding: '6px 10px', borderRadius: '6px', border: `1px solid ${HP.err}`, color: HP.err, background: HP.layer1, fontSize: HP_SMALL },
      pill: (tone) => ({ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 7px', borderRadius: '999px', border: `1px solid ${tone}`, color: tone, fontSize: '11px', fontWeight: 600 }),
    };

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

    // ------------------------------------------------------------------
    // Details surface: one clean, modern overview (no tabs, no command lines)
    // ------------------------------------------------------------------

    /** Panel design tokens, all from the alias theme. */
    const DH = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px',
        borderRadius: '12px',
        border: `1px solid ${HP.border1}`,
        background: HP.layer1,
      },
      metricGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px' },
      metricCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '10px 11px',
        borderRadius: '10px',
        border: `1px solid ${HP.border1}`,
        background: HP.base,
        minWidth: 0,
      },
      label: { fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: HP.sub, fontWeight: 600 },
      value: { fontSize: '20px', fontWeight: 700, lineHeight: 1.05, color: HP.text, fontVariantNumeric: 'tabular-nums' },
      sub: { fontSize: '10.5px', color: HP.sub, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
      rowLabel: { fontSize: '11.5px', color: HP.sub, whiteSpace: 'nowrap' },
      rowValue: { marginLeft: 'auto', fontSize: '11.5px', color: HP.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      barTrack: { height: '5px', borderRadius: '999px', background: HP.layer2, overflow: 'hidden', flex: '1 1 auto', minWidth: '40px' },
      pill: (tone) => ({ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 7px', borderRadius: '999px', border: `1px solid ${tone}`, color: tone, fontSize: '10px', fontWeight: 600, whiteSpace: 'nowrap' }),
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '11.5px', fontVariantNumeric: 'tabular-nums' },
      th: { textAlign: 'right', padding: '0 0 4px', color: HP.sub, fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, borderBottom: `1px solid ${HP.border1}` },
      thLeft: { textAlign: 'left', padding: '0 0 4px', color: HP.sub, fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600, borderBottom: `1px solid ${HP.border1}` },
      td: { textAlign: 'right', padding: '4px 0', color: HP.text, borderBottom: `1px solid ${HP.border1}` },
      tdLeft: { textAlign: 'left', padding: '4px 0', color: HP.text, borderBottom: `1px solid ${HP.border1}`, maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    };

    /**
     * Threshold tone for a 0-100 percentage.
     * @param {number} percent Value.
     * @param {number} [warn] Warn threshold.
     * @param {number} [danger] Danger threshold.
     * @returns {string} theme token.
     */
    function dhTone(percent, warn = 70, danger = 90) {
      return percent >= danger ? HP.err : percent >= warn ? HP.warn : HP.ok;
    }

    /**
     * Thin rounded progress line.
     * @param {{ percent: number, tone?: string }} props Bar props.
     * @returns {any} bar element.
     */
    function DhBar(props) {
      const percent = typeof props.percent === 'number' && Number.isFinite(props.percent) ? Math.max(0, Math.min(100, props.percent)) : 0;
      return h(
        'div',
        { style: DH.barTrack },
        h('div', { style: { width: `${percent}%`, height: '100%', borderRadius: '999px', background: props.tone ?? dhTone(percent), transition: 'width 400ms ease' } }),
      );
    }

    /**
     * One metric card: uppercase label, big value, bar, detail line.
     * @param {{ label: string, percent: number, detail?: string, tone?: string, value?: string }} props Card props.
     * @returns {any} card element.
     */
    function DhMetric(props) {
      const percent = typeof props.percent === 'number' && Number.isFinite(props.percent) ? Math.max(0, Math.min(100, props.percent)) : 0;
      return h(
        'div',
        { style: DH.metricCard },
        h('span', { style: DH.label }, props.label),
        h('span', { style: DH.value }, props.value ?? `${percent.toFixed(0)}%`),
        h(DhBar, { percent, tone: props.tone ?? dhTone(percent) }),
        props.detail !== undefined ? h('span', { style: DH.sub }, props.detail) : null,
      );
    }

    /**
     * Compact process table: name, PID, RAM, CPU. Never shows command lines.
     * @param {{ title: string, processes: any[] }} props Table props.
     * @returns {any} table element.
     */
    function DhProcessTable(props) {
      const processes = Array.isArray(props.processes) ? props.processes.slice(0, 6) : [];
      if (processes.length === 0) return null;
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
        h('span', { style: DH.label }, props.title),
        h(
          'table',
          { style: DH.table },
          h('thead', null, h('tr', null, h('th', { style: DH.thLeft }, 'Process'), h('th', { style: DH.th }, 'PID'), h('th', { style: DH.th }, 'RAM'), h('th', { style: DH.th }, 'CPU'))),
          h(
            'tbody',
            null,
            processes.map((process) =>
              h(
                'tr',
                { key: String(process.pid) },
                h('td', { style: DH.tdLeft, title: String(process.name ?? '') }, String(process.name ?? '?')),
                h('td', { style: DH.td }, String(process.pid ?? '?')),
                h('td', { style: DH.td }, typeof process.ramMb === 'number' ? `${Math.round(process.ramMb)} MB` : '—'),
                h('td', { style: DH.td }, typeof process.cpuPercent === 'number' ? `${process.cpuPercent.toFixed(1)}%` : '—'),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * The details surface: one glance at CPU, RAM, storage, battery, cores, and
     * the busiest processes. Rendered from data the widget already holds, so it
     * opens instantly instead of showing loading text.
     * @param {Record<string, any>} props Surface props.
     * @returns {any} details element.
     */
    function HostDetails(props) {
      const stats = props.stats;
      const host = stats !== null && typeof stats === 'object' ? stats.host ?? {} : {};
      const memory = stats !== null && typeof stats === 'object' ? stats.memory ?? {} : {};
      const cpu = stats !== null && typeof stats === 'object' ? stats.cpu ?? {} : {};
      const volumes = stats !== null && typeof stats === 'object' && Array.isArray(stats.volumes) ? stats.volumes : [];
      const battery = stats !== null && typeof stats === 'object' && stats.battery !== null && typeof stats.battery === 'object' ? stats.battery : null;
      const gpu = stats !== null && typeof stats === 'object' && stats.gpu !== null && typeof stats.gpu === 'object' ? stats.gpu : null;
      const warnings = stats !== null && typeof stats === 'object' && Array.isArray(stats.warnings) ? stats.warnings : [];

      const cpuPercent = typeof cpu.percent === 'number' ? cpu.percent : 0;
      const memPercent = typeof memory.usedPercent === 'number' ? memory.usedPercent : 0;
      const primary = volumes.length > 0 ? volumes[0] : null;
      const diskPercent = primary !== null && typeof primary.usedPercent === 'number' ? primary.usedPercent : 0;
      const perCore = Array.isArray(cpu.perCore) ? cpu.perCore.slice(0, 16) : [];

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '9px', minWidth: 0 } },

        h(
          'div',
          { style: DH.metricGrid },
          h(DhMetric, { label: 'CPU', percent: cpuPercent, detail: `${String(host.cpuCount ?? '?')} cores` }),
          h(DhMetric, { label: 'Memory', percent: memPercent, detail: `${hpBytes(memory.usedBytes)} of ${hpBytes(memory.totalBytes)}` }),
          h(DhMetric, {
            label: primary !== null ? `Disk ${String(primary.path)}` : 'Disk',
            percent: diskPercent,
            detail: primary !== null ? `${hpBytes(primary.freeBytes)} free` : 'unavailable',
          }),
        ),

        perCore.length > 0
          ? h(
              'div',
              { style: DH.card },
              h(
                'div',
                { style: DH.row },
                h('span', { style: DH.label }, 'Cores'),
                h('span', { style: { ...DH.sub, marginLeft: 'auto' } }, `max ${perCore.reduce((peak, core) => Math.max(peak, core.percent), 0).toFixed(0)}%`),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '2px', alignItems: 'flex-end', height: '22px' } },
                perCore.map((core) =>
                  h('div', {
                    key: String(core.index),
                    title: `Core ${core.index}: ${core.percent.toFixed(0)}%`,
                    style: { flex: '1 1 0', minWidth: '3px', height: `${Math.max(10, Math.min(100, core.percent))}%`, borderRadius: '2px', background: dhTone(core.percent, 70, 90), transition: 'height 400ms ease' },
                  }),
                ),
              ),
            )
          : null,

        h(
          'div',
          { style: DH.card },
          volumes.length > 0
            ? volumes.map((volume) =>
                h(
                  'div',
                  { key: String(volume.path), style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                  h(
                    'div',
                    { style: DH.row },
                    h('span', { style: DH.rowLabel }, `Disk ${String(volume.path)}`),
                    h('span', { style: DH.rowValue }, `${hpBytes(volume.usedBytes)} / ${hpBytes(volume.totalBytes)} · ${Number(volume.usedPercent ?? 0).toFixed(0)}%`),
                  ),
                  h(DhBar, { percent: volume.usedPercent, tone: dhTone(volume.usedPercent, 80, 93) }),
                ),
              )
            : null,
          battery !== null
            ? h(
                'div',
                { style: DH.row },
                h('span', { style: DH.rowLabel }, 'Battery'),
                h('span', { style: DH.pill(battery.charging === true ? HP.ok : dhTone(100 - (Number(battery.percent) || 0), 60, 30)) }, `${Math.round(Number(battery.percent) || 0)}% ${battery.charging === true ? '· charging' : '· on battery'}`),
                typeof battery.runtimeMinutes === 'number' ? h('span', { style: { ...DH.sub, marginLeft: 'auto' } }, `~${hpUptime(battery.runtimeMinutes * 60)} left`) : null,
              )
            : null,
          gpu !== null
            ? h(
                'div',
                { style: DH.row },
                h('span', { style: DH.rowLabel }, 'GPU'),
                h('span', { style: { ...DH.sub, marginLeft: 'auto' } }, `${String(gpu.name ?? 'GPU')}${typeof gpu.utilizationPercent === 'number' ? ` · ${gpu.utilizationPercent}%` : ''}`),
              )
            : null,
          typeof memory.committedBytes === 'number'
            ? h(
                'div',
                { style: DH.row },
                h('span', { style: DH.rowLabel }, 'Committed'),
                h('span', { style: DH.rowValue }, hpBytes(memory.committedBytes)),
              )
            : null,
        ),

        h(
          'div',
          { style: DH.card },
          h(DhProcessTable, { title: 'Top CPU', processes: stats?.topCpu }),
          stats?.topRam !== undefined ? h('div', { style: { marginTop: '4px' } }, h(DhProcessTable, { title: 'Top RAM', processes: stats?.topRam })) : null,
        ),

        warnings.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              warnings.map((warning, index) =>
                h('div', { key: String(index), style: { ...DH.sub, color: HP.warn, whiteSpace: 'normal' } }, `⚠ ${String(warning.message ?? warning.code ?? 'warning')}`),
              ),
            )
          : null,
      );
    }

    /**
     * Sidebar icon for the Host health panel.
     * @param {{ size?: number, active?: boolean }} props Icon props.
     * @returns {any} svg element.
     */
    function HostHealthIcon(props) {
      const iconProps = props ?? {};
      const size = typeof iconProps.size === 'number' && iconProps.size > 0 ? iconProps.size : 20;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { color: iconProps.active === true ? HP.text : HP.sub, display: 'block' },
        },
        h('path', { d: 'M3 13h4l2.5-6 3 12 2.5-8 2 2h4' }),
        h('path', { d: 'M3 20h18' }),
      );
    }

    // ------------------------------------------------------------------
    // App-bar usage strip: compact RAM/CPU/disk readout + details popover
    // ------------------------------------------------------------------

    /**
     * Minimal render guard: a details view that throws still renders the error
     * text, so the dropdown never appears silently empty.
     */
    class HostHealthGuard extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error !== null) {
          const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
          return h(
            'div',
            { style: { padding: '8px', color: HP.err, fontSize: '11.5px', whiteSpace: 'pre-wrap' } },
            `Host health view failed: ${message}`,
          );
        }
        return this.props.children;
      }
    }
    /** Strip typography and chrome. */
    const STRIP = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '26px',
      padding: '0 9px',
      borderRadius: '999px',
      border: `1px solid ${HP.border1}`,
      background: HP.layer1,
      color: HP.sub,
      font: 'inherit',
      fontSize: '11.5px',
      lineHeight: 1,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      WebkitAppRegion: 'no-drag',
      pointerEvents: 'auto',
    };
    /** Fixed seat in the window's top strip, left of the native window buttons. */
    const STRIP_SEAT = {
      position: 'fixed',
      top: '8px',
      right: '156px',
      zIndex: 3000,
      display: 'inline-flex',
      pointerEvents: 'auto',
      WebkitAppRegion: 'no-drag',
    };
    const STRIP_DOT = (tone) => ({ width: '6px', height: '6px', borderRadius: '50%', background: tone, flex: 'none' });
    const POPOVER = {
      position: 'fixed',
      top: 0,
      right: 8,
      zIndex: 2000,
      width: 'min(460px, 92vw)',
      maxHeight: '76vh',
      overflow: 'auto',
      padding: '12px',
      borderRadius: '14px',
      border: `1px solid ${HP.border2}`,
      background: HP.overlay,
      backdropFilter: 'blur(14px)',
    };

    /**
     * Compact usage strip: one glance gives CPU, RAM, and free disk; a click
     * opens the full details popover (overview, ports, stale processes).
     * @returns {any} strip element.
     */
    function HostUsageWidget() {
      const { useState, useEffect, useCallback, useRef } = React;
      const [stats, setStats] = useState(null);
      const [error, setError] = useState(null);
      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState(null);
      const rootRef = useRef(null);

      const load = useCallback(async () => {
        try {
          const payload = await hpFetchJson(hpApiUrl('stats'));
          setStats(payload.value ?? null);
          setError(null);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, []);

      useEffect(() => {
        load();
        const timer = setInterval(load, 3_000);
        return () => clearInterval(timer);
      }, [load]);

      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const node = rootRef.current;
          const target = event.target;
          if (node !== null && target instanceof Node && !node.contains(target)) setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
      }, [open]);

      const host = stats !== null && typeof stats === 'object' ? stats.host ?? null : null;
      const memory = stats !== null && typeof stats === 'object' ? stats.memory ?? null : null;
      const cpu = stats !== null && typeof stats === 'object' ? stats.cpu ?? null : null;
      const disk = stats !== null && typeof stats === 'object' ? stats.disk ?? null : null;

      const cpuPercent = cpu !== null && typeof cpu === 'object' && typeof cpu.percent === 'number' ? cpu.percent : null;
      const memPercent = memory !== null && typeof memory === 'object' && typeof memory.usedPercent === 'number' ? memory.usedPercent : null;
      const diskFree = disk !== null && typeof disk === 'object' && typeof disk.freeBytes === 'number' ? disk.freeBytes : null;
      const battery =
        stats !== null && typeof stats === 'object' && stats.battery !== null && typeof stats.battery === 'object'
          ? stats.battery
          : null;
      const batteryPercent = battery !== null && typeof battery.percent === 'number' ? battery.percent : null;

      const parts = [];
      if (cpuPercent !== null) parts.push(`CPU ${cpuPercent.toFixed(0)}%`);
      if (memPercent !== null) parts.push(`RAM ${memPercent.toFixed(0)}%`);
      if (diskFree !== null) parts.push(`${hpBytes(diskFree)} free`);
      if (batteryPercent !== null) parts.push(`${battery.charging === true ? 'AC' : 'BAT'} ${batteryPercent.toFixed(0)}%`);
      if (error !== null) parts.push('offline');

      const tone = error !== null ? HP.err : memPercent !== null && memPercent >= 92 ? HP.err : memPercent !== null && memPercent >= 80 ? HP.warn : HP.ok;
      const label = parts.length > 0 ? parts.join(' · ') : 'Host …';
      const uptime = host !== null && typeof host === 'object' ? hpUptime(host.uptimeSeconds) : '—';
      const hostName = host !== null && typeof host === 'object' && typeof host.hostname === 'string' ? host.hostname : 'host';

      return h(
        'div',
        { ref: rootRef, style: STRIP_SEAT, 'data-host-health-strip': 'app-bar' },
        h(
          'button',
          {
            type: 'button',
            style: STRIP,
            title: error ?? `${hostName} · up ${uptime}`,
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => {
              if (!open) {
                const node = rootRef.current;
                if (node !== null) {
                  const rect = node.getBoundingClientRect();
                  setAnchor({ top: rect.bottom + 8, right: Math.max(8, window.innerWidth - rect.right) });
                }
              }
              setOpen((current) => !current);
            },
          },
          h('span', { style: STRIP_DOT(tone), 'aria-hidden': true }),
          h('span', null, label),
          h(
            'svg',
            {
              width: 10,
              height: 10,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 2.6,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
              style: { transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' },
            },
            h('path', { d: 'M6 9l6 6 6-6' }),
          ),
        ),
        open
          ? h(
              'div',
              { style: { ...POPOVER, ...(anchor !== null ? { top: anchor.top, right: anchor.right } : {}) }, 'data-host-health-popover': 'open' },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '8px' } },
                h('span', { style: { fontWeight: 700, fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase', color: HP.sub } }, 'Host health'),
                h('span', { style: { color: HP.text, fontSize: '12.5px', fontWeight: 600 } }, hostName),
                h('span', { style: { color: HP.sub, fontSize: '11px' } }, `· up ${uptime}`),
                h('span', { style: { flex: '1 1 auto' } }),
                h(
                  'button',
                  {
                    type: 'button',
                    style: { ...HPP.button, padding: '1px 8px', borderRadius: '999px' },
                    onClick: () => setOpen(false),
                    'aria-label': 'Close host health details',
                  },
                  '✕',
                ),
              ),
              h(HostHealthGuard, null, h(HostDetails, { stats })),
              error !== null ? h('div', { style: { marginTop: '6px', color: HP.err, fontSize: '11px', whiteSpace: 'pre-wrap' } }, `Host API: ${error}`) : null,
            )
          : null,
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
        // Compact usage strip pinned to the window's top strip (the frame-wide
        // overlay layer sits above every column, outside scroll containers, so
        // it is visible for every Session and workspace). Clicking it opens the
        // details popover; the full numbers live there instead of a panel.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'host-health', order: 100, label: 'Host health' },
            HostUsageWidget,
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
