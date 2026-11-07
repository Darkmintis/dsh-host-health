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
