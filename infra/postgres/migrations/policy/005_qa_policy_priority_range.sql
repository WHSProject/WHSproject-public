-- QA 정책(qa-npm-policy 0.1.0) Rule 우선순위를 Dashboard Rule 페이지 범위(1~100, 중복 불가)로 맞춘다.
-- 큰 값부터 평가하는 순서는 그대로 유지한다(002·004의 400~1000 → 1~100).

BEGIN;

UPDATE policy_rules AS rule
SET priority = mapping.priority,
    updated_at = CURRENT_TIMESTAMP
FROM policies AS policy,
    (VALUES
        ('RULE-REJECT-CONFIRMED-EXFIL', 100),
        ('RULE-REJECT-CHILD-PROCESS', 95),
        ('RULE-REJECT-REMOTE-CODE', 90),
        ('RULE-REVIEW-CREDENTIAL-ACCESS', 85),
        ('RULE-REVIEW-OBFUSCATION', 80),
        ('RULE-REVIEW-FUNCTIONALITY-MISMATCH', 75),
        ('RULE-HOLD-NATIVE-BINARY', 70),
        ('RULE-ACCEPT-BENIGN', 60),
        ('RULE-HOLD-UNKNOWN-LINK', 50),
        ('RULE-REVIEW-OSV-HIGH', 40),
        ('RULE-HOLD-SCAN-TIMEOUT', 20),
        ('RULE-REJECT-SHELL-EXEC', 10)
    ) AS mapping(rule_code, priority)
WHERE rule.policy_id = policy.id
  AND policy.policy_key = 'qa-npm-policy'
  AND policy.version = '0.1.0'
  AND rule.rule_code = mapping.rule_code;

COMMIT;
