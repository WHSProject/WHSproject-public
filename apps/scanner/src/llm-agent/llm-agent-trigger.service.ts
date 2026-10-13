import { Injectable } from '@nestjs/common';
import type { AnalyzerResult } from '../domain/analysis.types';
import type { AtomicEvidenceV0_1 } from '../evidence/normalizer/evidence-normalizer.types';
import type { AgentPackageContext, AgentTriggerCondition, AgentTriggerDecision, AgentTriggerMode } from './agent.contract';

/** Only structured Scanner rules and normalized signals contribute to risk decisions. */
export function matchedAgentConditions(context: AgentPackageContext, results: readonly AnalyzerResult[], evidences: readonly AtomicEvidenceV0_1[]): AgentTriggerCondition[] {
  const findings = results.flatMap((result) => result.findings.map((finding) => ({ analyzer: result.analyzer, finding })));
  const rules = new Set(findings.map(({ analyzer, finding }) => `${analyzer}:${finding.ruleId}`));
  const signals = new Set(evidences.map((evidence) => evidence.signal.type));
  const has = (rule: string): boolean => rules.has(`custom-rule:${rule}`);
  const lifecycle = context.lifecycleScripts.length > 0 || signals.has('LIFECYCLE_SCRIPT') || has('custom.lifecycle-entry') || has('custom.lifecycle-process-coexistence');
  const execution = signals.has('CHILD_PROCESS') || signals.has('SHELL_EXEC') || has('custom.process-execution') || has('custom.lifecycle-process-coexistence');
  const sensitive = ['CREDENTIAL_READ', 'SECRET_READ', 'SENSITIVE_FILE_READ'].some((signal) => signals.has(signal)) || has('custom.sensitive-file-access') || has('custom.sensitive-file-network-coexistence');
  const network = signals.has('NETWORK_EGRESS') || signals.has('REMOTE_FETCH') || has('custom.network-outbound') || has('custom.remote-download') || has('custom.env-network-coexistence') || has('custom.sensitive-file-network-coexistence');
  const download = signals.has('REMOTE_FETCH') || has('custom.remote-download');
  const write = signals.has('FILE_WRITE') || has('custom.filesystem.write');
  const conditions: AgentTriggerCondition[] = [];
  // A high-confidence GuardDog threat keeps the legacy Agent route available
  // when Tier 2 restoration cannot produce a handoff. This is Agent routing,
  // not a Tier 1 malicious verdict; generic capability-only signals remain
  // excluded from this condition.
  if (findings.some(({ analyzer, finding }) => (
    analyzer === 'guarddog'
    && finding.type === 'THREAT_INDICATOR'
    && finding.ruleId.startsWith('threat-')
  ))) conditions.push('GUARDDOG_THREAT_FOUND');
  if (lifecycle && execution) conditions.push('LIFECYCLE_WITH_PROCESS_EXECUTION');
  if (sensitive && network) conditions.push('SENSITIVE_ACCESS_WITH_NETWORK');
  if (download && execution && (write || lifecycle)) conditions.push('DOWNLOAD_WRITE_EXECUTION_COMBINATION');
  if (signals.has('OBFUSCATED_CODE')) conditions.push('OBFUSCATION_FOUND');
  return conditions;
}

@Injectable()
export class LlmAgentTriggerService {
  decide(mode: AgentTriggerMode, context: AgentPackageContext, results: readonly AnalyzerResult[], evidences: readonly AtomicEvidenceV0_1[]): AgentTriggerDecision {
    if (mode === 'DISABLED') return { mode, shouldExecute: false, matchedConditions: [], reason: 'AGENT_DISABLED' };
    const matchedConditions = matchedAgentConditions(context, results, evidences);
    if (mode === 'ALWAYS') return { mode, shouldExecute: true, matchedConditions, reason: 'ALWAYS_MODE' };
    return { mode, shouldExecute: matchedConditions.length > 0, matchedConditions, reason: matchedConditions.length > 0 ? 'RISK_CONDITION_MATCHED' : 'NO_RISK_CONDITION' };
  }
}
