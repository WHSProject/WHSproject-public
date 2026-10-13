BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM policies
        WHERE ecosystem = 'npm'
          AND status = 'PUBLISHED'
    ) THEN
        RAISE EXCEPTION
            'A published npm policy already exists. QA fixture was not inserted.';
    END IF;
END
$$;

WITH qa_policy AS (
    INSERT INTO policies (
        policy_key,
        name,
        description,
        ecosystem,
        version,
        status,
        created_by,
        updated_by,
        published_at
    )
    VALUES (
        'qa-npm-policy',
        'QA npm Security Policy',
        'Published policy fixture for Policy DB Integration QA.',
        'npm',
        '0.1.0',
        'PUBLISHED',
        'qa-fixture',
        'qa-fixture',
        CURRENT_TIMESTAMP
    )
    RETURNING id
)
INSERT INTO policy_rules (
    policy_id,
    rule_code,
    rule_kind,
    name,
    description,
    enabled,
    decision,
    priority,
    condition_json,
    reason_code,
    reason_message
)
SELECT
    qa_policy.id,
    rules.rule_code,
    rules.rule_kind,
    rules.name,
    rules.description,
    rules.enabled,
    rules.decision,
    rules.priority,
    rules.condition_json,
    rules.reason_code,
    rules.reason_message
FROM qa_policy
CROSS JOIN (
    VALUES
    (
        'RULE-ACCEPT-BENIGN',
        'HARD',
        'Accept safe package',
        'Accept packages when benign intent is supported.',
        TRUE,
        'ACCEPT',
        100,
        '{"when":{"allOf":[{"predicate":"BENIGN_ALTERNATIVE_SUPPORTED"}]},"minimumSupport":"SUPPORTED","onUnknown":"HOLD"}'::jsonb,
        'POLICY_PASSED',
        'Package passed the active npm security policy.'
    ),
    (
        'RULE-HOLD-UNKNOWN-LINK',
        'HARD',
        'Hold unresolved decisive link',
        'Hold packages when a decisive evidence link is unresolved.',
        TRUE,
        'REVIEW',
        80,
        '{"when":{"allOf":[{"predicate":"DECISIVE_LINK_UNRESOLVED"}]},"minimumSupport":"PARTIAL","onUnknown":"HOLD"}'::jsonb,
        'MANUAL_REVIEW_REQUIRED',
        'Package requires manual review.'
    ),
    (
        'RULE-REJECT-SHELL-EXEC',
        'HARD',
        'Reject shell execution signal',
        'Reject packages with a shell execution signal.',
        TRUE,
        'REJECT',
        10,
        '{"when":{"allOf":[{"predicate":"DATA_REACHES_PROCESS_EXECUTION"}]},"minimumSupport":"SUPPORTED","onUnknown":"HOLD"}'::jsonb,
        'MALICIOUS_SIGNAL_DETECTED',
        'A malicious shell execution signal was detected.'
    ),
    (
        'RULE-HOLD-SCAN-TIMEOUT',
        'HARD',
        'Hold scanner timeout',
        'Hold packages that require additional scanning.',
        TRUE,
        'HOLD',
        20,
        '{"when":{"allOf":[{"predicate":"ANALYSIS_COVERAGE_INCOMPLETE"}]},"minimumSupport":"PARTIAL","onUnknown":"HOLD"}'::jsonb,
        'ADDITIONAL_SCAN_REQUIRED',
        'Additional scanning is required.'
    ),
    (
        'RULE-REVIEW-OSV-HIGH',
        'HARD',
        'Review high OSV advisory',
        'Require review when a validated OSV advisory has high severity.',
        TRUE,
        'REVIEW',
        70,
        '{"when":{"allOf":[{"predicate":"OSV_ADVISORY_APPLIES"}]},"minimumSupport":"SUPPORTED","onUnknown":"REVIEW"}'::jsonb,
        'OSV_ADVISORY_REVIEW',
        'A validated OSV advisory requires manual review.'
    )
) AS rules(
    rule_code,
    rule_kind,
    name,
    description,
    enabled,
    decision,
    priority,
    condition_json,
    reason_code,
    reason_message
);

COMMIT;
