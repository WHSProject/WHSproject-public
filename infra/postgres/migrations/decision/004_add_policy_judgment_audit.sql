BEGIN;

ALTER TABLE decisions
    ADD COLUMN IF NOT EXISTS judgment_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS policy_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS decisions_judgment_id_idx
    ON decisions (judgment_id);

COMMENT ON COLUMN decisions.judgment_id
    IS 'Policy GPT judgment identifier used before deterministic resolution.';

COMMENT ON COLUMN decisions.policy_hash
    IS 'SHA-256 hash of the active Policy snapshot used for this Decision.';

COMMIT;
