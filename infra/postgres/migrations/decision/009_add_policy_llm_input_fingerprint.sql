BEGIN;

ALTER TABLE policy_llm_judgments
    ADD COLUMN IF NOT EXISTS provider VARCHAR(64),
    ADD COLUMN IF NOT EXISTS prompt_version VARCHAR(64),
    ADD COLUMN IF NOT EXISTS input_hash VARCHAR(64);

COMMENT ON COLUMN policy_llm_judgments.provider
    IS 'Provider adapter that produced this Policy LLM attempt, for example openai or fixture.';

COMMENT ON COLUMN policy_llm_judgments.prompt_version
    IS 'Version of the Policy LLM prompt contract used for this attempt.';

COMMENT ON COLUMN policy_llm_judgments.input_hash
    IS 'SHA-256 of the exact logical prompt string sent to the Provider; distinct from policy_hash.';

COMMIT;
