BEGIN;

ALTER TABLE evidences
    DROP CONSTRAINT IF EXISTS evidences_kind_check,
    DROP CONSTRAINT IF EXISTS evidences_generated_by_check;

ALTER TABLE evidences
    ADD CONSTRAINT evidences_kind_check
        CHECK (kind IN ('ATOMIC', 'CORRELATED', 'LLM_ASSESSMENT')),
    ADD CONSTRAINT evidences_generated_by_check
        CHECK (generated_by IN ('EVIDENCE_NORMALIZER', 'EVIDENCE_CORRELATOR', 'LLM_AGENT'));

ALTER TABLE evidence_locations
    DROP CONSTRAINT IF EXISTS evidence_locations_role_check;

ALTER TABLE evidence_locations
    ADD CONSTRAINT evidence_locations_role_check
        CHECK (role IN (
            'OBSERVATION',
            'SOURCE',
            'SINK',
            'ENTRYPOINT',
            'TRIGGER',
            'TRANSFORM',
            'CONDITION',
            'CONTEXT'
        ));

COMMIT;
