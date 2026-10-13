BEGIN;

ALTER TABLE policies
    ADD COLUMN IF NOT EXISTS created_by_user_id UUID,
    ADD COLUMN IF NOT EXISTS updated_by_user_id UUID;

COMMENT ON COLUMN policies.created_by_user_id
    IS 'Dashboard user UUID captured when this policy version was created; no cross-database foreign key.';
COMMENT ON COLUMN policies.updated_by_user_id
    IS 'Dashboard user UUID captured when this policy version was last updated or published; no cross-database foreign key.';

COMMIT;
