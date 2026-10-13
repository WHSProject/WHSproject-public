BEGIN;

ALTER TABLE decisions
    ALTER COLUMN score DROP NOT NULL;

COMMENT ON COLUMN decisions.score
    IS 'Deprecated compatibility field. Policy decisions no longer use a numeric risk score.';

COMMIT;
