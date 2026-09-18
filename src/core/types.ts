export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface DecisionEvent {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly tenantId: string;
  readonly time: string;
  readonly state: Json;
}
export type Question =
  | { readonly type: 'noul'; readonly instructions: string }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly [string, string, ...string[]] };
export type Questions = Readonly<Record<string, Question>>;
export type Answer =
  | { readonly type: 'noul'; readonly noul: number }
  | { readonly type: 'choice'; readonly choice: string; readonly confidence: number; readonly probabilities: Readonly<Record<string, number>> }
  | { readonly type: 'score'; readonly score: number; readonly confidence: number; readonly probabilities: Readonly<Record<string, number>> };
export type Answers = Readonly<Record<string, Answer>>;
export interface ProviderResult {
  readonly model: string;
  readonly answers: Answers;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}
export interface DecisionProvider {
  readonly id: string;
  evaluate(state: Json, questions: Questions, signal: AbortSignal): Promise<ProviderResult>;
}
export type Effect = 'allow' | 'deny' | 'confirm' | 'escalate';
export interface Condition {
  readonly answer: string;
  readonly metric: 'value' | 'confidence';
  readonly op: 'eq' | 'gte' | 'lte';
  readonly value: string | number;
}
export interface PolicyRule {
  readonly id: string;
  readonly all: readonly Condition[];
  readonly effect: Effect;
  readonly directive?: string;
}
export interface DecisionPack {
  readonly id: string;
  readonly version: string;
  readonly eventType: string;
  readonly questions: Questions;
  /** First matching rule wins. Order is part of the versioned contract. */
  readonly rules: readonly PolicyRule[];
  readonly fallback: 'deny' | 'confirm' | 'escalate';
}
export interface Verdict {
  readonly effect: Effect;
  readonly ruleId: string;
  readonly directive?: string;
}
export interface ProposedAction { readonly toolId: string; readonly args: Json }
export interface Principal { readonly id: string; readonly tenantId: string }
export interface Tool {
  readonly id: string;
  /** Trusted host registration, never populated from model/user claims. */
  readonly effect: 'read' | 'write' | 'destructive';
  readonly idempotent: boolean;
  readonly speculatable: boolean;
  execute(args: Json, signal: AbortSignal): Promise<Json>;
}
export interface AuditRecord {
  readonly kind: 'decision.started' | 'decision.completed' | 'action.started' | 'outcome';
  readonly source: string;
  readonly eventId: string;
  readonly tenantId: string;
  readonly time: string;
  readonly details: Readonly<Record<string, Json>>;
}
export interface Ledger { append(record: AuditRecord): Promise<void> }
export type RunStatus = 'shadow' | 'blocked' | 'assessed' | 'succeeded' | 'recovery_required';
export interface RunResult {
  readonly eventId: string;
  readonly status: RunStatus;
  readonly verdict: Verdict;
  readonly provider?: ProviderResult;
  readonly output?: Json;
  readonly reasonCode?: string;
}
