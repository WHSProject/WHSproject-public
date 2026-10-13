BEGIN;

INSERT INTO policy_rules (
    policy_id, rule_code, rule_kind, name, description, enabled, decision,
    priority, condition_json, reason_code, reason_message
)
SELECT
    policy.id, rules.rule_code, 'HARD', rules.name, rules.description, TRUE,
    rules.decision, rules.priority, rules.condition_json::jsonb,
    rules.reason_code, rules.reason_message
FROM policies AS policy
CROSS JOIN (
    VALUES
    (
        'RULE-REJECT-CONFIRMED-EXFIL',
        'Reject confirmed credential exfiltration',
        'Confirmed credential access reaches an external sink through a reachable path.',
        'REJECT', 1000,
        '{"when":{"allOf":[{"predicate":"CREDENTIAL_SOURCE_ACCESSED"},{"predicate":"DATA_REACHES_EXTERNAL_SINK"},{"predicate":"EXECUTION_PATH_REACHABLE"},{"predicate":"BENIGN_ALTERNATIVE_NOT_SUPPORTED"}]},"minimumSupport":"SUPPORTED","onUnknown":"HOLD"}',
        'POLICY_CONFIRMED_CREDENTIAL_EXFILTRATION',
        'Credential-bearing data reaches an external sink through a supported execution path.'
    ),
    (
        'RULE-REJECT-CHILD-PROCESS',
        'Reject confirmed child-process execution',
        'A reachable package path spawns a child process without a supported benign explanation.',
        'REJECT', 950,
        '{"when":{"allOf":[{"predicate":"CHILD_PROCESS_SPAWNED"},{"predicate":"EXECUTION_PATH_REACHABLE"},{"predicate":"BENIGN_ALTERNATIVE_NOT_SUPPORTED"}]},"minimumSupport":"SUPPORTED","onUnknown":"HOLD"}',
        'POLICY_CONFIRMED_CHILD_PROCESS_EXECUTION',
        'A child process execution path was directly supported by package evidence.'
    ),
    (
        'RULE-REJECT-REMOTE-CODE',
        'Reject lifecycle remote code fetch',
        'A lifecycle path fetches executable code from a remote source.',
        'REJECT', 900,
        '{"when":{"allOf":[{"predicate":"LIFECYCLE_TRIGGERED"},{"predicate":"REMOTE_CODE_FETCH"},{"predicate":"EXECUTION_PATH_REACHABLE"},{"predicate":"BENIGN_ALTERNATIVE_NOT_SUPPORTED"}]},"minimumSupport":"SUPPORTED","onUnknown":"HOLD"}',
        'POLICY_REMOTE_CODE_FETCH',
        'A lifecycle execution path fetches remote executable code without a supported benign explanation.'
    ),
    (
        'RULE-REVIEW-CREDENTIAL-ACCESS',
        'Review credential source access',
        'Credential access requires review when external transmission is not fully established.',
        'REVIEW', 700,
        '{"when":{"allOf":[{"predicate":"CREDENTIAL_SOURCE_ACCESSED"},{"predicate":"INDEPENDENT_SUPPORT_PRESENT"}]},"minimumSupport":"SUPPORTED","onUnknown":"REVIEW"}',
        'POLICY_CREDENTIAL_ACCESS_REVIEW',
        'The package accesses a credential-bearing source and requires policy review.'
    ),
    (
        'RULE-REVIEW-OBFUSCATION',
        'Review material obfuscation',
        'Material obfuscation combined with incomplete analysis requires review.',
        'REVIEW', 600,
        '{"when":{"allOf":[{"predicate":"OBFUSCATION_PRESENT"},{"predicate":"ANALYSIS_COVERAGE_INCOMPLETE"}]},"minimumSupport":"PARTIAL","onUnknown":"REVIEW"}',
        'POLICY_OBFUSCATION_REVIEW',
        'Obfuscation prevents a complete determination of package behavior.'
    ),
    (
        'RULE-REVIEW-FUNCTIONALITY-MISMATCH',
        'Review functionality mismatch',
        'Observed behavior materially differs from the package purpose.',
        'REVIEW', 500,
        '{"when":{"allOf":[{"predicate":"FUNCTIONALITY_MISMATCH"},{"predicate":"INDEPENDENT_SUPPORT_PRESENT"}]},"minimumSupport":"SUPPORTED","onUnknown":"REVIEW"}',
        'POLICY_FUNCTIONALITY_MISMATCH',
        'Observed behavior is inconsistent with the declared package functionality.'
    ),
    (
        'RULE-HOLD-NATIVE-BINARY',
        'Hold native binary loading',
        'Native binary loading requires additional analysis when reachability is incomplete.',
        'HOLD', 400,
        '{"when":{"allOf":[{"predicate":"NATIVE_BINARY_LOADED"},{"predicate":"ANALYSIS_COVERAGE_INCOMPLETE"}]},"minimumSupport":"PARTIAL","onUnknown":"HOLD"}',
        'POLICY_NATIVE_BINARY_ANALYSIS_REQUIRED',
        'Native code was loaded while analysis coverage was incomplete.'
    )
) AS rules(rule_code, name, description, decision, priority, condition_json, reason_code, reason_message)
WHERE policy.policy_key = 'qa-npm-policy'
  AND policy.version = '0.1.0'
  AND policy.status = 'PUBLISHED'
ON CONFLICT (policy_id, rule_code) DO NOTHING;

COMMIT;
