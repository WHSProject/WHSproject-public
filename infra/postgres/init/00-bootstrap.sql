\set ON_ERROR_STOP on

SELECT format('CREATE DATABASE %I', 'evidence_db')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'evidence_db')\gexec

SELECT format('CREATE DATABASE %I', 'policy_db')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'policy_db')\gexec

SELECT format('CREATE DATABASE %I', 'decision_db')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'decision_db')\gexec

\connect evidence_db
\i /migrations/evidence/001_initial.sql
\i /migrations/evidence/002_llm_assessment.sql

\connect policy_db
\i /migrations/policy/001_initial.sql
\i /migrations/policy/002_qa_fixture.sql
\i /migrations/policy/003_predicate_registry.sql
\i /migrations/policy/004_expand_qa_policy.sql
\i /migrations/policy/005_qa_policy_priority_range.sql
\i /migrations/policy/006_policy_actor_user_ids.sql

\connect decision_db
\i /migrations/decision/001_initial.sql
\i /migrations/decision/002_add_decision_id.sql
\i /migrations/decision/003_make_score_nullable.sql
\i /migrations/decision/004_add_policy_judgment_audit.sql
\i /migrations/decision/005_add_feed_persistence.sql
\i /migrations/decision/006_add_decision_provenance.sql
\i /migrations/decision/007_add_policy_llm_judgment_audit.sql
\i /migrations/decision/008_add_feed_reevaluation.sql
\i /migrations/decision/009_add_policy_llm_input_fingerprint.sql

-- Dashboard 사용자 DB (Dashboard 소유)
SELECT format('CREATE DATABASE %I', 'user_db')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'user_db')\gexec

\connect user_db
\i /migrations/user/001_initial.sql
\i /migrations/user/002_account_management.sql
\i /migrations/user/003_download_events_root.sql
\i /migrations/user/004_npm_tokens.sql
\i /migrations/user/005_install_dependency_history.sql
