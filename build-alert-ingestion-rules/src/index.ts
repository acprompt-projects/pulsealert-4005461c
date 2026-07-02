import express from 'express';
import { v4 as uuid } from 'uuid';
import { AlertEvent, AlertRule, Severity, RouteTarget, AlertState, EvalResult } from './types';

const app = express();
app.use(express.json());

// ── In-memory stores ──────────────────────────────────────────
const alertStore = new Map<string, AlertState>();
const rules: AlertRule[] = [];

// ── Default rules ─────────────────────────────────────────────
rules.push(
  { id: uuid(), name: 'critical-to-slack', condition: { severity: 'critical' }, targets: [{ type: 'slack', channel: '#incidents' }], escalateAfterSec: 300 },
  { id: uuid(), name: 'warning-to-discord', condition: { severity: 'warning' }, targets: [{ type: 'discord', channel: 'alerts' }], escalateAfterSec: 600 },
  { id: uuid(), name: 'any-to-email', condition: {}, targets: [{ type: 'email', address: 'ops@example.com' }], escalateAfterSec: 0 },
);

// ── Rules engine ──────────────────────────────────────────────
function evaluateRules(alert: AlertEvent): EvalResult[] {
  const results: EvalResult[] = [];
  for (const rule of rules) {
    const cond = rule.condition;
    const severityMatch = !cond.severity || cond.severity === alert.severity;
    const sourceMatch = !cond.source || cond.source === alert.source;
    const tagMatch = !cond.tags || Object.entries(cond.tags).every(([k, v]) => alert.tags?.[k] === v);
    if (severityMatch && sourceMatch && tagMatch) {
      results.push({ ruleId: rule.id, ruleName: rule.name, targets: rule.targets, escalateAfterSec: rule.escalateAfterSec });
    }
  }
  return results;
}

// ── Notification dispatcher (stub – real impl would call APIs) ─
function dispatch(target: RouteTarget, alert: AlertEvent): void {
  const ts = new Date().toISOString();
  switch (target.type) {
    case 'slack':    console.log(`[${ts}] SLACK  → ${target.channel}: [${alert.severity.toUpperCase()}] ${alert.message} (source=${alert.source})`); break;
    case 'discord':  console.log(`[${ts}] DISCORD→ ${target.channel}: [${alert.severity.toUpperCase()}] ${alert.message} (source=${alert.source})`); break;
    case 'email':    console.log(`[${ts}] EMAIL  → ${target.address}: [${alert.severity.toUpperCase()}] ${alert.message} (source=${alert.source})`); break;
  }
}

// ── Core ingestion ────────────────────────────────────────────
function ingestAlert(alert: AlertEvent): AlertState {
  const existing = alertStore.get(alert.dedupKey);
  if (existing) {
    existing.count += 1;
    existing.lastSeen = new Date();
    existing.evalResults = evaluateRules(alert);
    return existing;
  }
  const evalResults = evaluateRules(alert);
  const state: AlertState = { id: uuid(), alert, count: 1, firstSeen: new Date(), lastSeen: new Date(), evalResults, escalated: false };
  alertStore.set(alert.dedupKey, state);

  // Immediate dispatch
  for (const result of evalResults) {
    for (const target of result.targets) {
      dispatch(target, alert);
    }
  }
  return state;
}

// ── Escalation check (poll every 15s) ─────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const state of alertStore.values()) {
    if (state.escalated) continue;
    for (const result of state.evalResults) {
      if (result.escalateAfterSec <= 0) continue;
      const elapsed = (now - state.firstSeen.getTime()) / 1000;
      if (elapsed >= result.escalateAfterSec) {
        const escalationTarget: RouteTarget = { type: 'email', address: 'escalation@example.com' };
        dispatch(escalationTarget, state.alert);
        state.escalated = true;
        break;
      }
    }
  }
}, 15_000);

// ── REST API ──────────────────────────────────────────────────
app.post('/alerts', (req, res) => {
  const body = req.body as Partial<AlertEvent>;
  if (!body.message || !body.source || !body.dedupKey) {
    return res.status(400).json({ error: 'message, source, and dedupKey are required' });
  }
  const severity: Severity = ['info','warning','critical'].includes(body.severity as Severity) ? (body.severity as Severity) : 'info';
  const alert: AlertEvent = { id: uuid(), message: body.message, source: body.source, severity, dedupKey: body.dedupKey, timestamp: new Date(), tags: body.tags ?? {} };
  const state = ingestAlert(alert);
  res.status(201).json({ alertId: state.id, count: state.count, routes: state.evalResults });
});

app.get('/alerts', (_req, res) => {
  const list = Array.from(alertStore.values()).map(s => ({ id: s.id, dedupKey: s.alert.dedupKey, severity: s.alert.severity, count: s.count, firstSeen: s.firstSeen, lastSeen: s.lastSeen, escalated: s.escalated }));
  res.json(list);
});

app.get('/alerts/:dedupKey', (req, res) => {
  const state = alertStore.get(req.params.dedupKey);
  if (!state) return res.status(404).json({ error: 'not found' });
  res.json(state);
});

app.delete('/alerts/:dedupKey', (req, res) => {
  const deleted = alertStore.delete(req.params.dedupKey);
  res.json({ deleted });
});

app.get('/rules', (_req, res) => res.json(rules));

app.post('/rules', (req, res) => {
  const body = req.body as Partial<AlertRule>;
  if (!body.name || !body.targets?.length) return res.status(400).json({ error: 'name and targets[] required' });
  const rule: AlertRule = { id: uuid(), name: body.name, condition: body.condition ?? {}, targets: body.targets, escalateAfterSec: body.escalateAfterSec ?? 0 };
  rules.push(rule);
  res.status(201).json(rule);
});

app.delete('/rules/:id', (req, res) => {
  const idx = rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const removed = rules.splice(idx, 1)[0];
  res.json(removed);
});

app.get('/health', (_req, res) => res.json({ status: 'ok', alerts: alertStore.size, rules: rules.length }));

const PORT = Number(process.env.PORT ?? 3100);
app.listen(PORT, () => console.log(`pulsealert ingestion service listening on :${PORT}`));