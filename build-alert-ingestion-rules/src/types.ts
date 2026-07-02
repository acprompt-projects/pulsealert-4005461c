export type Severity = 'info' | 'warning' | 'critical';

export interface AlertEvent {
  id?: string;
  message: string;
  source: string;
  severity: Severity;
  dedupKey: string;
  timestamp?: Date;
  tags?: Record<string, string>;
}

export interface RouteTarget {
  type: 'slack' | 'discord' | 'email';
  channel?: string;
  address?: string;
}

export interface RuleCondition {
  severity?: Severity;
  source?: string;
  tags?: Record<string, string>;
}

export interface AlertRule {
  id: string;
  name: string;
  condition: RuleCondition;
  targets: RouteTarget[];
  escalateAfterSec: number;
}

export interface EvalResult {
  ruleId: string;
  ruleName: string;
  targets: RouteTarget[];
  escalateAfterSec: number;
}

export interface AlertState {
  id: string;
  alert: AlertEvent;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  evalResults: EvalResult[];
  escalated: boolean;
}