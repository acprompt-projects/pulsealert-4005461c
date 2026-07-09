import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import htm from 'htm';

const html = htm.bind(React.createElement);

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080/ws/alerts';
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080';

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2, ok: 3 };
const SEVERITY_COLORS = {
  critical: 'bg-red-500/20 text-red-400 border-red-500/40',
  warning: 'bg-amber-500/20 text-amber-400 border-amber-500/40',
  info: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
  ok: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
};
const SEVERITY_DOT = { critical: 'bg-red-500', warning: 'bg-amber-500', info: 'bg-blue-500', ok: 'bg-emerald-500' };

function useWebSocket(url) {
  const [alerts, setAlerts] = useState([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => { setConnected(false); reconnectTimer.current = setTimeout(connect, 3000); };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          setAlerts(prev => [event, ...prev].slice(0, 200));
        } catch {}
      };
    } catch { reconnectTimer.current = setTimeout(connect, 3000); }
  }, [url]);

  useEffect(() => { connect(); return () => { clearTimeout(reconnectTimer.current); wsRef.current?.close(); }; }, [connect]);
  return { alerts, connected };
}

function StatsCards({ alerts }) {
  const counts = { critical: 0, warning: 0, info: 0, ok: 0, acknowledged: 0 };
  alerts.forEach(a => { counts[a.severity] = (counts[a.severity] || 0) + 1; if (a.acknowledged) counts.acknowledged++; });
  const cards = [
    { label: 'Critical', value: counts.critical, color: 'text-red-400', bg: 'bg-red-500/10' },
    { label: 'Warning', value: counts.warning, color: 'text-amber-400', bg: 'bg-amber-500/10' },
    { label: 'Info', value: counts.info, color: 'text-blue-400', bg: 'bg-blue-500/10' },
    { label: 'Healthy', value: counts.ok, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    { label: 'Acknowledged', value: counts.acknowledged, color: 'text-gray-400', bg: 'bg-gray-500/10' },
  ];
  return html`<div class="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
    ${cards.map(c => html`<div key=${c.label} class=${`${c.bg} rounded-lg p-4 border border-gray-800`}>
      <div class="text-xs text-gray-500 uppercase tracking-wider">${c.label}</div>
      <div class=${`text-2xl font-bold mt-1 ${c.color}`}>${c.value}</div>
    </div>`)}
  </div>`;
}

function SeverityChart({ alerts }) {
  const buckets = {};
  const now = Date.now();
  alerts.forEach(a => {
    const age = now - new Date(a.timestamp).getTime();
    if (age > 3600000) return;
    const slot = Math.floor(age / 300000);
    buckets[slot] = buckets[slot] || { critical: 0, warning: 0, info: 0, ok: 0 };
    buckets[slot][a.severity] = (buckets[slot][a.severity] || 0) + 1;
  });
  const slots = Array.from({ length: 12 }, (_, i) => buckets[i] || { critical: 0, warning: 0, info: 0, ok: 0 });
  const maxVal = Math.max(1, ...slots.flatMap(s => Object.values(s)));
  const barColors = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6', ok: '#10b981' };
  return html`<div class="bg-gray-900 rounded-lg p-4 border border-gray-800 mb-6">
    <div class="text-xs text-gray-500 uppercase tracking-wider mb-3">Alerts — Last 60 min (5-min buckets)</div>
    <div class="flex items-end gap-1 h-24">
      ${slots.map((s, i) => {
        const total = s.critical + s.warning + s.info + s.ok;
        const hPct = (total / maxVal) * 100;
        const topSev = Object.entries(s).sort((a, b) => b[1] - a[1])[0];
        return html`<div key=${i} class="flex-1 rounded-t" style=${{ height: `${Math.max(hPct, 2)}%`, backgroundColor: total ? barColors[topSev[0]] : '#374151', opacity: 0.8, transition: 'height 0.3s' }} title=${`${12 - i * 5}m ago: ${total} alerts`}></div>`;
      })}
    </div>
    <div class="flex justify-between text-xs text-gray-600 mt-1"><span>-60m</span><span>-30m</span><span>now</span></div>
  </div>`;
}

function AlertRow({ alert, onAck }) {
  const ts = new Date(alert.timestamp);
  const timeStr = ts.toLocaleTimeString();
  const sevClass = SEVERITY_COLORS[alert.severity] || SEVERITY_COLORS.info;
  const dotClass = SEVERITY_DOT[alert.severity] || SEVERITY_DOT.info;
  return html`<div class="flex items-start gap-3 p-3 rounded-lg border border-gray-800 bg-gray-900/50 hover:bg-gray-900 transition-colors">
    <span class=${`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${dotClass}`}></span>
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
        <span class=${`text-xs font-semibold px-2 py-0.5 rounded border ${sevClass}`}>${alert.severity.toUpperCase()}</span>
        <span class="font-medium text-gray-200 truncate">${alert.service || alert.name || 'Unknown'}</span>
        <span class="text-xs text-gray-500 ml-auto flex-shrink-0">${timeStr}</span>
      </div>
      <p class="text-sm text-gray-400 mt-1 truncate">${alert.message || alert.description || ''}</p>
      ${alert.labels ? html`<div class="flex gap-1 mt-1 flex-wrap">${Object.entries(alert.labels).map(([k, v]) => html`<span key=${k} class="text-xs bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded">${k}=${v}</span>`)}</div>` : null}
    </div>
    ${!alert.acknowledged ? html`<button onClick=${() => onAck(alert.id)} class="flex-shrink-0 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded transition-colors border border-gray-700">ACK</button>` : html`<span class="flex-shrink-0 text-xs text-emerald-500 px-2 py-1">✓ ACK</span>`}
  </div>`;
}

function App() {
  const { alerts, connected } = useWebSocket(WS_URL);
  const [filters, setFilters] = useState({ critical: true, warning: true, info: true, ok: true });
  const [search, setSearch] = useState('');
  const acking = useRef(new Set());

  const toggleFilter = (sev) => setFilters(f => ({ ...f, [sev]: !f[sev] }));

  const acknowledge = useCallback(async (id) => {
    if (acking.current.has(id)) return;
    acking.current.add(id);
    try {
      await fetch(`${API_URL}/alerts/${id}/acknowledge`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    } catch {}
    acking.current.delete(id);
  }, []);

  const filtered = alerts.filter(a => {
    if (!filters[a.severity]) return false;
    if (search) {
      const q = search.toLowerCase();
      return (a.service || '').toLowerCase().includes(q) || (a.message || '').toLowerCase().includes(q) || (a.name || '').toLowerCase().includes(q);
    }
    return true;
  });

  return html`<div class="max-w-5xl mx-auto px-4 py-6">
    <header class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-bold tracking-tight">PulseAlert</h1>
        <p class="text-sm text-gray-500">Real-time alert dashboard</p>
      </div>
      <div class="flex items-center gap-2">
        <span class=${`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`}></span>
        <span class="text-xs text-gray-500">${connected ? 'Live' : 'Disconnected'}</span>
      </div>
    </header>

    <${StatsCards} alerts=${alerts} />
    <${SeverityChart} alerts=${alerts} />

    <div class="flex flex-wrap items-center gap-2 mb-4">
      ${['critical', 'warning', 'info', 'ok'].map(sev => html`<button key=${sev} onClick=${() => toggleFilter(sev)} class=${`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${filters[sev] ? SEVERITY_COLORS[sev] : 'bg-gray-900 text-gray-600 border-gray-800'}`}>${sev.toUpperCase()}</button>`)}
      <input type="text" placeholder="Search services…" value=${search} onInput=${e => setSearch(e.target.value)} class="ml-auto text-sm bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-600 w-48" />
    </div>

    <div class="space-y-2">
      ${filtered.length === 0 ? html`<div class="text-center text-gray-600 py-12">No alerts matching filters</div>` : filtered.slice(0, 50).map(a => html`<${AlertRow} key=${a.id} alert=${a} onAck=${acknowledge} />`)}
    </div>
    ${filtered.length > 50 ? html`<p class="text-xs text-gray-600 text-center mt-4">Showing 50 of ${filtered.length} alerts</p>` : null}
  </div>`;
}

createRoot(document.getElementById('root')).render(html`<${App} />`);