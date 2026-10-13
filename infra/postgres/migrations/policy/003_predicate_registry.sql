BEGIN;

CREATE TABLE IF NOT EXISTS policy_predicates (
    code TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    requires_feed_evidence BOOLEAN NOT NULL DEFAULT FALSE,
    reject_allowed BOOLEAN NOT NULL DEFAULT TRUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO policy_predicates (code, description, category, requires_feed_evidence, reject_allowed)
VALUES
    ('LIFECYCLE_TRIGGERED', 'The package executes this behavior from an install, lifecycle, or startup hook.', 'execution', FALSE, TRUE),
    ('EXECUTION_PATH_REACHABLE', 'The analyzed code path can reach the claimed operation in the package runtime.', 'execution', FALSE, TRUE),
    ('SENSITIVE_DATA_ACCESSED', 'The package reads credentials, tokens, secrets, or other sensitive local data.', 'data', FALSE, TRUE),
    ('DATA_REACHES_EXTERNAL_SINK', 'Data reaches a network or other external sink controlled outside the package.', 'data', FALSE, TRUE),
    ('DATA_REACHES_PROCESS_EXECUTION', 'Data reaches a child-process, shell, interpreter, or native execution sink.', 'execution', FALSE, TRUE),
    ('BENIGN_ALTERNATIVE_SUPPORTED', 'The observed behavior has a directly supported benign explanation.', 'context', FALSE, TRUE),
    ('BENIGN_ALTERNATIVE_NOT_SUPPORTED', 'The supplied evidence does not support a benign explanation for the behavior.', 'context', FALSE, TRUE),
    ('FUNCTIONALITY_MISMATCH', 'Observed behavior is materially unrelated to the package functionality or declared purpose.', 'context', FALSE, TRUE),
    ('REFERENCE_VALID', 'The package metadata, documentation, or claimed reference is supported by supplied evidence.', 'context', FALSE, TRUE),
    ('INDEPENDENT_SUPPORT_PRESENT', 'The decisive claim has independent corroboration from a separate evidence source.', 'corroboration', FALSE, TRUE),
    ('DECISIVE_LINK_UNRESOLVED', 'A link needed for the policy decision is missing or cannot be established.', 'coverage', FALSE, TRUE),
    ('ANALYSIS_COVERAGE_INCOMPLETE', 'Required analysis coverage is incomplete for this package or execution path.', 'coverage', FALSE, TRUE),
    ('OSV_ADVISORY_APPLIES', 'A validated OSV advisory applies to this package and version.', 'feed', TRUE, FALSE),
    ('ARTIFACT_IDENTITY_MATCHES', 'The scanned artifact identity matches the requested package identity.', 'identity', FALSE, TRUE),
    ('PACKAGE_INSTALL_SCRIPT_PRESENT', 'The package contains an install or lifecycle script that can execute during installation.', 'execution', FALSE, TRUE),
    ('NETWORK_REQUEST_INITIATED', 'The package initiates an outbound network request.', 'network', FALSE, TRUE),
    ('CHILD_PROCESS_SPAWNED', 'The package spawns a child process or invokes a shell command.', 'execution', FALSE, TRUE),
    ('CREDENTIAL_SOURCE_ACCESSED', 'The package accesses a credential-bearing source such as environment variables or local config.', 'data', FALSE, TRUE),
    ('REMOTE_CODE_FETCH', 'The package fetches executable code or a script from a remote source.', 'network', FALSE, TRUE),
    ('NATIVE_BINARY_LOADED', 'The package loads a native binary or dynamically linked module.', 'execution', FALSE, TRUE),
    ('OBFUSCATION_PRESENT', 'The package contains obfuscation that materially limits code or intent inspection.', 'analysis', FALSE, TRUE)
ON CONFLICT (code) DO NOTHING;

CREATE INDEX IF NOT EXISTS policy_predicates_enabled_idx
    ON policy_predicates (enabled, category, code);

COMMIT;
