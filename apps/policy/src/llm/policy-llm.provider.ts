import type { PolicyJudgment } from '../contracts/judgment';
import type { PolicyPredicate } from '../contracts/policy';
import { policyLlmInputHash } from './policy-llm.audit';

export interface PolicyLlmResponse {
  judgment: unknown;
  model: string;
  provider?: string;
  providerRequestId?: string;
  durationMs: number;
  usage?: PolicyLlmUsage;
  /** Provider response envelope retained for the audit record. */
  rawResponse?: unknown;
}

/** Usage reported by the provider. Values are never inferred from text length. */
export interface PolicyLlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

export interface PolicyLlmProvider {
  analyze(input: string, signal: AbortSignal): Promise<PolicyLlmResponse>;
}

export class PolicyLlmError extends Error {
  constructor(message: string, readonly retryable = false, readonly rawResponse?: unknown) { super(message); }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function normalizePolicyLlmUsage(value: unknown): PolicyLlmUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const inputTokens = integer(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = integer(usage.output_tokens ?? usage.outputTokens);
  const totalTokens = integer(usage.total_tokens ?? usage.totalTokens);
  const cachedInputTokens = integer(
    usage.cached_input_tokens
      ?? usage.cachedInputTokens
      ?? record(usage.input_tokens_details)?.cached_tokens
      ?? record(usage.inputTokenDetails)?.cachedTokens,
  );
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && cachedInputTokens === undefined) return undefined;
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens };
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export class OpenAiPolicyLlmProvider implements PolicyLlmProvider {
  constructor(private readonly config: { apiKey?: string; model: string; baseUrl: string }, private readonly fetcher: typeof fetch = fetch) {}

  async analyze(input: string, signal: AbortSignal): Promise<PolicyLlmResponse> {
    if (!this.config.apiKey?.trim()) throw new PolicyLlmError('POLICY_LLM_API_KEY_MISSING');
    const started = performance.now();
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.baseUrl.replace(/\/+$/u, '')}/v1/responses`, {
        method: 'POST', signal, headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.config.model, input, store: false, text: { format: { type: 'json_schema', name: 'policy_judgment', strict: true, schema: policyJudgmentSchemaForInput(input) } } }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new PolicyLlmError('POLICY_LLM_TRANSPORT_FAILED', true);
    }
    if (!response.ok) {
      let rawResponse: unknown;
      try { rawResponse = await response.json(); } catch { /* non-JSON provider errors have no raw payload */ }
      throw new PolicyLlmError(`POLICY_LLM_HTTP_${response.status}`, response.status === 429 || response.status >= 500, rawResponse);
    }
    let decoded: unknown;
    try { decoded = await response.json(); } catch { throw new PolicyLlmError('POLICY_LLM_INVALID_RESPONSE', true); }
    const payload = record(decoded);
    if (!payload) throw new PolicyLlmError('POLICY_LLM_INVALID_RESPONSE', true);
    const output = Array.isArray(payload?.output) ? payload.output.flatMap((item) => {
      const message = record(item);
      return Array.isArray(message?.content) ? message.content.map(record).filter((part): part is Record<string, unknown> => part !== null) : [];
    }) : [];
    const text = output.find((part) => part.type === 'output_text' && typeof part.text === 'string')?.text;
    if (typeof text !== 'string') throw new PolicyLlmError('POLICY_LLM_EMPTY_OUTPUT', true, payload);
    try {
      return {
        judgment: JSON.parse(text),
        provider: 'openai',
        model: typeof payload.model === 'string' ? payload.model : this.config.model,
        providerRequestId: typeof payload.id === 'string' ? payload.id : undefined,
        durationMs: performance.now() - started,
        usage: normalizePolicyLlmUsage(payload.usage),
        rawResponse: payload,
      };
    } catch { throw new PolicyLlmError('POLICY_LLM_INVALID_JSON', true, payload); }
  }
}

/**
 * Deterministic provider for offline CI/integration smoke tests.
 * Production deployments must use OpenAiPolicyLlmProvider instead.
 */
export class FixturePolicyLlmProvider implements PolicyLlmProvider {
  constructor(private readonly options: { scenario?: 'evidence' | 'positive' | 'negative'; targetPredicate?: string } = {}) {}

  async analyze(input: string, signal: AbortSignal): Promise<PolicyLlmResponse> {
    if (signal.aborted) throw new PolicyLlmError('POLICY_LLM_ABORTED');
    const started = performance.now();
    const payload = parseFixturePrompt(input);
    const policy = payload.policySnapshot;
    const observations = [...payload.policyCase.observations, ...payload.policyCase.assessments];
    const atomicEvidenceId = payload.policyCase.observations.find((item) => typeof item.evidenceId === 'string')?.evidenceId;
    const assessment = payload.policyCase.assessments.find((item) => typeof record(item.provenance)?.assessmentId === 'string');
    const assessmentId = typeof record(assessment?.provenance)?.assessmentId === 'string' ? String(record(assessment?.provenance)?.assessmentId) : undefined;
    const feedEvidenceId = payload.policyCase.osvEvidence.find((item) => typeof item.feedEvidenceId === 'string')?.feedEvidenceId;
    const scenario = this.options.scenario ?? (process.env.POLICY_LLM_FIXTURE_SCENARIO as 'evidence' | 'positive' | 'negative' | undefined) ?? 'evidence';
    const targetPredicate = this.options.targetPredicate ?? process.env.POLICY_LLM_FIXTURE_TARGET_PREDICATE;
    const ruleEvaluations = policy.rules.map((rule) => {
      const predicates = [...(rule.when.allOf ?? []), ...(rule.when.anyOf ?? [])].map(({ predicate }) => {
        const definition = policy.predicateCatalog.find((item) => item.code === predicate);
        const usesFeed = definition?.requiresFeedEvidence === true;
        const supported = shouldSupportPredicate(predicate, scenario, targetPredicate, observations, usesFeed ? Boolean(feedEvidenceId) : Boolean(atomicEvidenceId) || Boolean(assessmentId));
        return {
          predicate,
          status: supported ? 'SUPPORTED' : 'NOT_SUPPORTED',
          evidenceIds: supported && !usesFeed && atomicEvidenceId ? [atomicEvidenceId] : [],
          assessmentIds: supported && !usesFeed && !atomicEvidenceId && assessmentId ? [assessmentId] : [],
          feedEvidenceIds: supported && usesFeed && feedEvidenceId ? [feedEvidenceId] : [],
          codeRefs: [],
          missing: [],
        };
      });
      const satisfied = predicates.length > 0 && predicates.every((predicate) => predicate.status === 'SUPPORTED');
      return {
        ruleId: rule.ruleId,
        status: satisfied ? 'SATISFIED' : 'NOT_SATISFIED',
        predicateEvaluations: predicates,
        counterEvidenceIds: [],
        rationale: 'Deterministic CI fixture judgment.',
      };
    });
    const judgment = {
        judgmentId: `fixture:${policyLlmInputHash(input).slice(0, 24)}`,
        policyVersion: policy.policyVersion,
        caseStatus: 'COMPLETE',
        ruleEvaluations,
        unresolved: [],
        conflicts: [],
        limitations: [],
        recommendedOutcome: null,
      };
    return {
      judgment,
      provider: 'fixture',
      model: 'fixture',
      durationMs: performance.now() - started,
      rawResponse: { output_text: JSON.stringify(judgment), model: 'fixture' },
    };
  }
}

function parseFixturePrompt(input: string): {
  policySnapshot: {
    policyVersion: string;
    predicateCatalog: Array<{ code: PolicyPredicate; requiresFeedEvidence?: boolean }>;
    rules: Array<{ ruleId: string; when: { allOf?: Array<{ predicate: PolicyPredicate }>; anyOf?: Array<{ predicate: PolicyPredicate }> } }>;
  };
  policyCase: { observations: Array<Record<string, unknown>>; assessments: Array<Record<string, unknown>>; osvEvidence: Array<Record<string, unknown>> };
} {
  const raw = input.trim().split('\n').at(-1);
  if (!raw) throw new PolicyLlmError('POLICY_FIXTURE_INVALID_PROMPT');
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const policySnapshot = record(parsed.policySnapshot);
    const policyCase = record(parsed.policyCase);
    const rules = Array.isArray(policySnapshot?.rules) ? policySnapshot.rules : [];
    const predicateCatalog = Array.isArray(policySnapshot?.predicateCatalog) ? policySnapshot.predicateCatalog : [];
    const observations = Array.isArray(policyCase?.observations) ? policyCase.observations : [];
    const assessments = Array.isArray(policyCase?.assessments) ? policyCase.assessments : [];
    const osvEvidence = Array.isArray(policyCase?.osvEvidence) ? policyCase.osvEvidence : [];
    if (typeof policySnapshot?.policyVersion !== 'string' || rules.some((rule) => !record(rule)?.ruleId || !record(record(rule)?.when))) throw new Error('invalid fixture prompt');
    return {
      policySnapshot: {
        policyVersion: policySnapshot.policyVersion,
        predicateCatalog: predicateCatalog.map((predicate) => {
          const item = record(predicate);
          return { code: String(item?.code ?? ''), requiresFeedEvidence: item?.requiresFeedEvidence === true };
        }).filter((predicate) => predicate.code.length > 0),
        rules: rules.map((rule) => {
          const item = record(rule)!;
          const when = record(item.when)!;
          return {
            ruleId: String(item.ruleId),
            when: {
              allOf: predicateConditions(when.allOf),
              anyOf: predicateConditions(when.anyOf),
            },
          };
        }),
      },
      policyCase: {
        observations: observations.filter((item): item is Record<string, unknown> => record(item) !== null),
        assessments: assessments.filter((item): item is Record<string, unknown> => record(item) !== null),
        osvEvidence: osvEvidence.filter((item): item is Record<string, unknown> => record(item) !== null),
      },
    };
  } catch (error) {
    if (error instanceof PolicyLlmError) throw error;
    throw new PolicyLlmError('POLICY_FIXTURE_INVALID_PROMPT');
  }
}

function shouldSupportPredicate(predicate: PolicyPredicate, scenario: 'evidence' | 'positive' | 'negative', targetPredicate: string | undefined, observations: Array<Record<string, unknown>>, hasCitation: boolean): boolean {
  if (!hasCitation || scenario === 'negative') return false;
  if (scenario === 'positive') return targetPredicate === undefined || predicate === targetPredicate;
  if (predicate === 'BENIGN_ALTERNATIVE_SUPPORTED') return true;
  const haystack = observations.map((observation) => JSON.stringify(observation).toUpperCase()).join('\n');
  return haystack.includes(predicate.toUpperCase());
}

function predicateConditions(value: unknown): Array<{ predicate: PolicyPredicate }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { predicate: PolicyPredicate } => {
    const predicate = record(item)?.predicate;
    return typeof predicate === 'string' && predicate.length > 0;
  });
}

export const policyJudgmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'judgmentId',
    'policyVersion',
    'caseStatus',
    'ruleEvaluations',
    'unresolved',
    'conflicts',
    'limitations',
    'recommendedOutcome',
  ],
  properties: {
    judgmentId: { type: 'string' },
    policyVersion: { type: 'string' },
    caseStatus: { enum: ['COMPLETE', 'PARTIAL', 'INCOMPLETE'] },
    ruleEvaluations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ruleId', 'status', 'predicateEvaluations', 'counterEvidenceIds', 'rationale'],
        properties: {
          ruleId: { type: 'string' },
          status: {
            enum: ['SATISFIED', 'NOT_SATISFIED', 'UNKNOWN', 'CONFLICT'],
            description: 'Mechanical summary of this rule\'s predicate statuses and allOf/anyOf only; not a final decision. CONFLICT if any predicate conflicts; otherwise SATISFIED if every allOf is SUPPORTED and anyOf is empty or has a SUPPORTED predicate; otherwise UNKNOWN if any allOf is UNKNOWN or no anyOf is SUPPORTED and some anyOf is UNKNOWN; otherwise NOT_SATISFIED. Effect, priority, minimumSupport, and onUnknown do not affect this status.',
          },
          predicateEvaluations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
                required: ['predicate', 'status', 'evidenceIds', 'assessmentIds', 'feedEvidenceIds', 'codeRefs', 'missing'],
              properties: {
                predicate: {
                  type: 'string',
                  pattern: '^[A-Z][A-Z0-9_]{2,63}$',
                },
                status: { enum: ['SUPPORTED', 'NOT_SUPPORTED', 'UNKNOWN', 'CONFLICT'] },
                evidenceIds: { type: 'array', items: { type: 'string' } },
                assessmentIds: { type: 'array', items: { type: 'string' } },
                feedEvidenceIds: { type: 'array', items: { type: 'string' } },
                codeRefs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['file', 'lines'],
                    properties: {
                      file: { type: 'string' },
                      lines: {
                        type: 'array',
                        items: { type: 'integer' },
                        minItems: 2,
                        maxItems: 2,
                      },
                    },
                  },
                },
                missing: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          counterEvidenceIds: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
      },
    },
    unresolved: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
    limitations: { type: 'array', items: { type: 'string' } },
    recommendedOutcome: {
      anyOf: [
        { enum: ['ACCEPT', 'REJECT', 'HOLD', 'REVIEW'] },
        { type: 'null' },
      ],
    },
  },
};

/** Constrain each citation namespace to IDs present in this exact PolicyCase payload. */
export function policyJudgmentSchemaForInput(input: string): typeof policyJudgmentSchema {
  const payloadLine = input.trim().split('\n').at(-1);
  if (!payloadLine) return policyJudgmentSchema;
  let payload: Record<string, any>;
  try {
    payload = record(JSON.parse(payloadLine)) ?? {};
  } catch {
    return policyJudgmentSchema;
  }
  const policyCase = record(payload.policyCase);
  if (!policyCase) return policyJudgmentSchema;
  const observations = Array.isArray(policyCase.observations) ? policyCase.observations.map(record).filter(Boolean) as Array<Record<string, any>> : [];
  const assessments = Array.isArray(policyCase.assessments) ? policyCase.assessments.map(record).filter(Boolean) as Array<Record<string, any>> : [];
  const osvEvidence = Array.isArray(policyCase.osvEvidence) ? policyCase.osvEvidence.map(record).filter(Boolean) as Array<Record<string, any>> : [];
  const observationIds = stringIds(observations.map((item) => item.evidenceId));
  const allEvidenceIds = stringIds([...observations, ...assessments].map((item) => item.evidenceId));
  const verifiedAssessmentIds = stringIds(assessments
    .filter((item) => item.verificationStatus === 'VERIFIED')
    .flatMap((item) => [item.evidenceId, record(item.provenance)?.assessmentId]));
  const feedEvidenceIds = stringIds(osvEvidence.map((item) => item.feedEvidenceId));
  const schema = JSON.parse(JSON.stringify(policyJudgmentSchema)) as Record<string, any>;
  const predicateProperties = schema.properties.ruleEvaluations.items.properties.predicateEvaluations.items.properties;
  predicateProperties.evidenceIds.items = idSchema(observationIds);
  predicateProperties.assessmentIds.items = idSchema(verifiedAssessmentIds);
  predicateProperties.feedEvidenceIds.items = idSchema(feedEvidenceIds);
  schema.properties.ruleEvaluations.items.properties.counterEvidenceIds.items = idSchema(allEvidenceIds);
  return schema as typeof policyJudgmentSchema;
}

function stringIds(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function idSchema(ids: string[]): Record<string, unknown> {
  // Strict structured-output providers reject an empty enum. Empty-string sentinels
  // still prevent all real references; the deterministic validator rejects them.
  return { type: 'string', enum: ids.length > 0 ? ids : [''] };
}

export type PolicyJudgmentSchema = PolicyJudgment;
