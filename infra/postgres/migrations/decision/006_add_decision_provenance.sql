BEGIN;

ALTER TABLE decisions
    ADD COLUMN IF NOT EXISTS assessment_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMENT ON COLUMN decisions.assessment_ids
    IS 'LLM assessment identifiers cited by the rules used for this Decision.';

COMMIT;
