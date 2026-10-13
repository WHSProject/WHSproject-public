import { createHash } from 'node:crypto';
import type { PolicyPredicate, PolicyPredicateDefinition, PolicyRule, PolicySnapshot } from '../contracts/policy';

export class PolicyDbError extends Error {
  constructor(message: string, readonly statusCode?: number, readonly retryable = false) { super(message); }
}

export interface ActivePolicyClient {
  fetchActive(signal?: AbortSignal): Promise<PolicySnapshot>;
}

export class HttpActivePolicyClient implements ActivePolicyClient {
  constructor(private readonly baseUrl = process.env.POLICY_DB_URL ?? 'http://localhost:9000', private readonly timeoutMs = Number(process.env.POLICY_DB_TIMEOUT_MS ?? (Number(process.env.POLICY_DB_TIMEOUT_SECONDS ?? 5) * 1_000)), private readonly fetcher: typeof fetch = fetch) {}

  async fetchActive(signal?: AbortSignal): Promise<PolicySnapshot> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/+$/u, '')}/internal/v1/policies/active`, { headers: { accept: 'application/json' }, signal: controller.signal });
      if (!response.ok) throw new PolicyDbError(`POLICY_DB_HTTP_${response.status}`, response.status, response.status >= 500);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new PolicyDbError('POLICY_DB_INVALID_RESPONSE'); }
      return parseActivePolicy(payload);
    } catch (error) {
      if (error instanceof PolicyDbError) throw error;
      throw new PolicyDbError(controller.signal.aborted ? 'POLICY_DB_TIMEOUT' : 'POLICY_DB_UNAVAILABLE', undefined, true);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function parseActivePolicy(value: unknown): PolicySnapshot {
  if (!isRecord(value) || typeof value.policyKey !== 'string' || typeof value.policyVersion !== 'string' || value.ecosystem !== 'npm' || !Array.isArray(value.rules)) throw new PolicyDbError('POLICY_DB_INVALID_RESPONSE');
  const rules = value.rules.filter(isRecord).map(parseRule);
  const catalog = Array.isArray(value.predicates)
    ? value.predicates.filter(isRecord).map(parsePredicateDefinition)
    : derivePredicateCatalog(rules);
  const catalogCodes = new Set(catalog.map((predicate) => predicate.code));
  for (const rule of rules) {
    for (const condition of [...(rule.when.allOf ?? []), ...(rule.when.anyOf ?? [])]) {
      if (!catalogCodes.has(condition.predicate)) throw new PolicyDbError(`POLICY_DB_UNKNOWN_PREDICATE:${condition.predicate}`);
    }
  }
  const snapshot: PolicySnapshot = { policyKey: value.policyKey, policyVersion: value.policyVersion, ecosystem: 'npm', defaultDecision: 'ACCEPT', judgmentFailureDecision: value.judgmentFailureDecision === 'REVIEW' ? 'REVIEW' : 'HOLD', rules, predicateCatalog: catalog };
  return { ...snapshot, policyHash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
}

function parseRule(value: Record<string, unknown>): PolicyRule {
  const ruleId = string(value.ruleId) ?? string(value.ruleCode);
  const effect = decision(value.effect) ?? decision(value.decision);
  const conditions = isRecord(value.conditions) ? value.conditions : {};
  if (!ruleId || !effect || typeof value.reasonCode !== 'string') throw new PolicyDbError('POLICY_DB_INVALID_RULE');
  const when = isRecord(value.when) ? value.when : isRecord(conditions.when) ? conditions.when : {};
  const unsupportedConditionKeys = Object.keys(conditions).filter((key) => !['when', 'minimumSupport', 'onUnknown'].includes(key));
  if (unsupportedConditionKeys.length > 0) throw new PolicyDbError(`POLICY_DB_LEGACY_RULE_UNSUPPORTED:${unsupportedConditionKeys.join(',')}`);
  const rawPredicates = [...array(when.allOf), ...array(when.anyOf)];
  if (rawPredicates.some((item) => !isRecord(item) || !nonEmptyString(item.predicate))) throw new PolicyDbError('POLICY_DB_INVALID_RULE_PREDICATE');
  if (rawPredicates.length === 0 && ('scoreGte' in conditions || 'scoreLt' in conditions)) throw new PolicyDbError('POLICY_DB_SCORE_RULE_UNSUPPORTED');
  const allOf = array(when.allOf).filter(isRecord).map((item) => item.predicate).filter(nonEmptyString).map((predicate) => ({ predicate }));
  const anyOf = array(when.anyOf).filter(isRecord).map((item) => item.predicate).filter(nonEmptyString).map((predicate) => ({ predicate }));
  return { ruleId, ...(typeof value.name === 'string' ? { name: value.name } : {}), priority: typeof value.priority === 'number' ? value.priority : 0, effect, when: { ...(allOf.length ? { allOf } : {}), ...(anyOf.length ? { anyOf } : {}) }, minimumSupport: conditions.minimumSupport === 'PARTIAL' || value.minimumSupport === 'PARTIAL' ? 'PARTIAL' : 'SUPPORTED', onUnknown: conditions.onUnknown === 'REVIEW' || value.onUnknown === 'REVIEW' ? 'REVIEW' : conditions.onUnknown === 'IGNORE' || value.onUnknown === 'IGNORE' ? 'IGNORE' : 'HOLD', reasonCode: value.reasonCode };
}

function parsePredicateDefinition(value: Record<string, unknown>): PolicyPredicateDefinition {
  if (!nonEmptyString(value.code) || !nonEmptyString(value.description)) throw new PolicyDbError('POLICY_DB_INVALID_PREDICATE_DEFINITION');
  return {
    code: value.code,
    description: value.description,
    category: nonEmptyString(value.category) ? value.category : undefined,
    requiresFeedEvidence: value.requiresFeedEvidence === true,
    rejectAllowed: value.rejectAllowed !== false,
  };
}

function derivePredicateCatalog(rules: PolicyRule[]): PolicyPredicateDefinition[] {
  return [...new Set(rules.flatMap((rule) => [...(rule.when.allOf ?? []), ...(rule.when.anyOf ?? [])].map((condition) => condition.predicate)))].map((code) => ({ code, description: `Policy predicate ${code}`, rejectAllowed: true }));
}

function decision(value: unknown): PolicyRule['effect'] | undefined { return value === 'ACCEPT' || value === 'REJECT' || value === 'HOLD' || value === 'REVIEW' ? value : undefined; }
function nonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
