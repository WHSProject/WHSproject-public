import { createHash } from 'node:crypto';
import type { Decision } from '../contracts/evidence';

export type PolicyLlmRunMode = 'PRIMARY' | 'SHADOW';

export interface PolicyLlmAuditRecord {
  runMode: PolicyLlmRunMode;
  requestId: string;
  scanId: string;
  policyKey: string;
  policyVersion: string;
  policyHash?: string;
  provider: string;
  promptVersion: string;
  inputHash: string;
  judgmentId: string;
  status: 'COMPLETED' | 'FAILED';
  prompt: string;
  model?: string;
  providerRequestId?: string;
  durationMs?: number;
  judgmentJson?: unknown;
  responseJson?: unknown;
  failureCode?: string;
  resolvedDecision?: Decision;
  resolvedReasonCode?: string;
  shadowOfJudgmentId?: string;
  comparison?: {
    primaryDecision: Decision;
    shadowDecision?: Decision;
    decisionChanged: boolean;
    primaryReasonCode: string;
    shadowReasonCode?: string;
    reasonCodeChanged: boolean;
  };
  evaluatedAt: string;
}

/** SHA-256 of the exact prompt string supplied to the Policy LLM provider. */
export function policyLlmInputHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
