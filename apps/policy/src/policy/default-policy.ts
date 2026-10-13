import type { PolicySnapshot } from '../contracts/policy';

export const defaultPolicy: PolicySnapshot = {
  policyKey: 'npm-malware-default',
  policyVersion: '2.0.0',
  ecosystem: 'npm',
  defaultDecision: 'REVIEW',
  judgmentFailureDecision: 'HOLD',
  rules: [
    {
      ruleId: 'MALWARE-EXFIL-001', priority: 100, effect: 'REJECT',
      when: { allOf: [
        { predicate: 'SENSITIVE_DATA_ACCESSED' },
        { predicate: 'DATA_REACHES_EXTERNAL_SINK' },
        { predicate: 'EXECUTION_PATH_REACHABLE' },
        { predicate: 'BENIGN_ALTERNATIVE_NOT_SUPPORTED' },
      ] },
      minimumSupport: 'SUPPORTED', onUnknown: 'HOLD', reasonCode: 'POLICY_CONFIRMED_DATA_EXFILTRATION',
    },
    {
      ruleId: 'MALWARE-UNRESOLVED-001', priority: 80, effect: 'HOLD',
      when: { anyOf: [{ predicate: 'DECISIVE_LINK_UNRESOLVED' }, { predicate: 'ANALYSIS_COVERAGE_INCOMPLETE' }] },
      minimumSupport: 'PARTIAL', onUnknown: 'HOLD', reasonCode: 'POLICY_DECISIVE_EVIDENCE_MISSING',
    },
  ],
};
