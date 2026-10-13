from uuid import UUID

from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from .decision_db import connect
from .decision_models import (
    DecisionLookupRequest,
    DecisionLookupResponse,
    DecisionLookupResult,
    DecisionRecord,
    DecisionPackagesResponse,
    DecisionPackageSummary,
    DecisionPackageVersionsResponse,
    DecisionSummaryHourly,
    DecisionSummaryRecord,
    DecisionSaveRequest,
    FeedPersistenceRequest,
    FeedPersistenceResponse,
    FeedRefreshCandidate,
    FeedSnapshotRecord,
    ReevaluationJobClaimResponse,
    ReevaluationJobFailure,
    ReevaluationJobRecord,
    PolicyLlmJudgmentRecord,
    PolicyLlmJudgmentSaveRequest,
)


app = FastAPI(title="WHS Decision DB API", version="0.1.0")


def _llm_judgment_from_row(row: tuple) -> PolicyLlmJudgmentRecord:
    return PolicyLlmJudgmentRecord(
        id=row[0], runMode=row[1], requestId=row[2], scanId=row[3], policyKey=row[4],
        policyVersion=row[5], policyHash=row[6], provider=row[7], promptVersion=row[8], inputHash=row[9], judgmentId=row[10], status=row[11],
        prompt=row[12], model=row[13], providerRequestId=row[14], durationMs=float(row[15]) if row[15] is not None else None,
        judgmentJson=row[16], responseJson=row[17], failureCode=row[18], resolvedDecision=row[19],
        resolvedReasonCode=row[20], shadowOfJudgmentId=row[21], comparison=row[22], evaluatedAt=row[23], createdAt=row[24],
    )


LLM_JUDGMENT_COLUMNS = """
    SELECT id, run_mode, request_id, scan_id, policy_key, policy_version,
           policy_hash, provider, prompt_version, input_hash, judgment_id, status, prompt, model,
           provider_request_id, duration_ms, judgment_json, response_json, failure_code,
           resolved_decision, resolved_reason_code, shadow_of_judgment_id,
           comparison_json, evaluated_at, created_at
    FROM policy_llm_judgments
"""


def _record_from_row(row: tuple) -> DecisionRecord:
    return DecisionRecord(
        id=row[0],
        decisionId=row[1],
        requestId=row[2],
        score=float(row[3]) if row[3] is not None else None,
        decision=row[4],
        reasonCode=row[5],
        reason=row[6],
        matchedRuleIds=row[7],
        evidenceIds=row[8],
        scanId=row[9],
        policyKey=row[10],
        policyVersion=row[11],
        judgmentId=row[12],
        policyHash=row[13],
        assessmentIds=row[14] or [],
        feedSnapshotId=row[15],
        feedEvidenceIds=row[16],
        subject={
            "ecosystem": row[17],
            "packageName": row[18],
            "packageVersion": row[19],
            "artifactHash256": row[20],
            "artifactHash512": row[21],
        },
        evaluatedAt=row[22],
        createdAt=row[23],
        previousDecisionId=row[24] if len(row) > 24 else None,
        triggerSnapshotId=row[25] if len(row) > 25 else None,
    )


SELECT_COLUMNS = """
    SELECT id, decision_id, request_id, score, decision,
           reason_code, reason_message, matched_rule_ids, evidence_ids,
           scan_id, policy_key, policy_version, judgment_id, policy_hash,
           assessment_ids, feed_snapshot_id, feed_evidence_ids, ecosystem,
           package_name, package_version, artifact_hash_256,
           artifact_hash_512, evaluated_at, created_at,
           previous_decision_id, trigger_snapshot_id
    FROM decisions
"""

REEVALUATION_JOB_COLUMNS = """
    SELECT id, ecosystem, package_name, package_version,
           artifact_hash_256, artifact_hash_512, scan_id,
           previous_snapshot_id, trigger_snapshot_id, previous_decision_id,
           change_reason, status, error_code, error_detail,
           created_at, started_at, completed_at
    FROM reevaluation_jobs
"""


def _reevaluation_job_from_row(row: tuple) -> ReevaluationJobRecord:
    return ReevaluationJobRecord(
        id=row[0], ecosystem=row[1], packageName=row[2], packageVersion=row[3],
        artifactHash256=row[4], artifactHash512=row[5], scanId=row[6],
        previousSnapshotId=row[7], triggerSnapshotId=row[8],
        previousDecisionId=row[9], changeReason=row[10], status=row[11],
        errorCode=row[12], errorDetail=row[13], createdAt=row[14],
        startedAt=row[15], completedAt=row[16],
    )


def _record_job_event(cursor, job_id: UUID, from_status: str | None, to_status: str,
                      error_code: str | None = None, detail: str | None = None) -> None:
    cursor.execute(
        """INSERT INTO reevaluation_job_events
           (job_id, from_status, to_status, error_code, detail)
           VALUES (%s, %s, %s, %s, %s)""",
        (job_id, from_status, to_status, error_code, detail),
    )


def _complete_reevaluation_job(cursor, job_id: UUID) -> None:
    cursor.execute(
        "SELECT status FROM reevaluation_jobs WHERE id = %s FOR UPDATE",
        (job_id,),
    )
    row = cursor.fetchone()
    if row is None:
        raise RuntimeError("Reevaluation job was not found.")
    if row[0] == "COMPLETED":
        return
    if row[0] != "RUNNING":
        raise RuntimeError(f"Reevaluation job cannot complete from {row[0]}.")
    cursor.execute(
        """UPDATE reevaluation_jobs
           SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP,
               error_code = NULL, error_detail = NULL
           WHERE id = %s""",
        (job_id,),
    )
    _record_job_event(cursor, job_id, "RUNNING", "COMPLETED")


def _lookup_decisions(payload: DecisionLookupRequest) -> DecisionLookupResponse:
    values_sql = ", ".join(
        "(%s, %s, %s, %s)" for _ in payload.packages
    )
    parameters: list[str | int] = []
    for request_order, package in enumerate(payload.packages):
        parameters.extend(
            [
                package.packageName,
                package.version,
                package.integrity,
                request_order,
            ]
        )

    query = f"""
        WITH requested(package_name, package_version, integrity, request_order) AS (
            VALUES {values_sql}
        )
        SELECT requested.package_name,
               requested.package_version,
               requested.integrity,
               matched.decision_id,
               matched.decision,
               matched.policy_key,
               matched.policy_version,
               matched.evaluated_at
        FROM requested
        LEFT JOIN LATERAL (
            SELECT decision_id, decision, policy_key,
                   policy_version, evaluated_at
            FROM decisions
            WHERE ecosystem = 'npm'
              AND package_name = requested.package_name
              AND package_version = requested.package_version
              AND artifact_hash_512 = requested.integrity
            ORDER BY evaluated_at DESC, created_at DESC, id DESC
            LIMIT 1
        ) AS matched ON TRUE
        ORDER BY requested.request_order
    """

    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(query, parameters)
            rows = cursor.fetchall()

    results = []
    for row in rows:
        if row[3] is None:
            results.append(
                DecisionLookupResult(
                    packageName=row[0],
                    version=row[1],
                    integrity=row[2],
                    lookupStatus="NOT_FOUND",
                )
            )
            continue

        results.append(
            DecisionLookupResult(
                packageName=row[0],
                version=row[1],
                integrity=row[2],
                lookupStatus="FOUND",
                decisionId=row[3],
                decision=row[4],
                policyKey=row[5],
                policyVersion=row[6],
                evaluatedAt=row[7],
            )
        )

    return DecisionLookupResponse(
        requestId=payload.requestId,
        results=results,
    )


@app.get("/health")
def health() -> dict[str, str]:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    return {"status": "ok", "service": "decision-db-api"}


@app.post(
    "/internal/v1/decisions/lookup",
    response_model=DecisionLookupResponse,
    response_model_exclude_none=True,
)
def lookup_decisions(payload: DecisionLookupRequest) -> DecisionLookupResponse:
    return _lookup_decisions(payload)


PACKAGE_LATEST_CTE = """
    WITH ranked AS (
        SELECT decision_id, request_id, ecosystem, package_name,
               package_version AS version, decision, evaluated_at,
               matched_rule_ids, policy_key, policy_version,
               ROW_NUMBER() OVER (
                   PARTITION BY ecosystem, package_name, package_version
                   ORDER BY evaluated_at DESC, created_at DESC, id DESC
               ) AS row_number
        FROM decisions
        WHERE ecosystem = 'npm'
    ), latest AS (
        SELECT decision_id, request_id, ecosystem, package_name, version,
               decision, evaluated_at, matched_rule_ids, policy_key, policy_version
        FROM ranked WHERE row_number = 1
    )
"""


def _package_summary(row: tuple) -> DecisionPackageSummary:
    return DecisionPackageSummary(
        decisionId=row[0], requestId=row[1], packageName=row[2], version=row[3],
        decision=row[4], evaluatedAt=row[5], matchedRuleIds=row[6] or [],
        policyKey=row[7], policyVersion=row[8],
    )


@app.get("/internal/v1/decisions/packages", response_model=DecisionPackagesResponse)
def list_decision_packages(
    q: str | None = Query(default=None, max_length=100),
    decision: Literal["ACCEPT", "REJECT", "HOLD", "REVIEW"] | None = None,
    page: int = Query(default=1, ge=1),
    pageSize: int = Query(default=15, ge=1, le=100),
) -> DecisionPackagesResponse:
    where = ["TRUE"]
    parameters: list[object] = []
    if q:
        where.append("(POSITION(LOWER(%s) IN LOWER(package_name)) > 0 OR POSITION(LOWER(%s) IN LOWER(version)) > 0)")
        parameters.extend([q, q])
    if decision:
        where.append("decision = %s")
        parameters.append(decision)
    where_sql = " AND ".join(where)
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(f"{PACKAGE_LATEST_CTE} SELECT COUNT(*) FROM latest WHERE {where_sql}", parameters)
            total = cursor.fetchone()[0]
            cursor.execute(
                f"""{PACKAGE_LATEST_CTE}
                    SELECT decision_id, request_id, package_name, version, decision,
                           evaluated_at, matched_rule_ids, policy_key, policy_version
                    FROM latest WHERE {where_sql}
                    ORDER BY evaluated_at DESC, package_name ASC, version ASC
                    LIMIT %s OFFSET %s""",
                [*parameters, pageSize, (page - 1) * pageSize],
            )
            rows = cursor.fetchall()
    return DecisionPackagesResponse(total=total, page=page, pageSize=pageSize, items=[_package_summary(row) for row in rows])


@app.get("/internal/v1/decisions/package-versions", response_model=DecisionPackageVersionsResponse)
def list_decision_package_versions(packageName: str = Query(min_length=1, max_length=255)) -> DecisionPackageVersionsResponse:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""{PACKAGE_LATEST_CTE}
                    SELECT decision_id, request_id, package_name, version, decision,
                           evaluated_at, matched_rule_ids, policy_key, policy_version
                    FROM latest WHERE package_name = %s
                    ORDER BY evaluated_at DESC, version DESC""",
                (packageName,),
            )
            rows = cursor.fetchall()
    return DecisionPackageVersionsResponse(packageName=packageName, versions=[_package_summary(row) for row in rows])


@app.get("/internal/v1/decisions/summary", response_model=DecisionSummaryRecord)
def get_decision_summary(
    from_date: datetime = Query(alias="from"),
    to_date: datetime = Query(alias="to"),
) -> DecisionSummaryRecord:
    if from_date.utcoffset() is None or to_date.utcoffset() is None or from_date >= to_date:
        raise HTTPException(status_code=422, detail={"code": "INVALID_DATE_RANGE", "message": "from and to must be timezone-aware and from must precede to."})
    by_decision = {value: 0 for value in ("ACCEPT", "REJECT", "HOLD", "REVIEW")}
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """SELECT decision, COUNT(*) FROM decisions
                   WHERE evaluated_at >= %s AND evaluated_at < %s
                   GROUP BY decision""",
                (from_date, to_date),
            )
            for value, count in cursor.fetchall():
                if value in by_decision:
                    by_decision[value] = count
            cursor.execute(
                """SELECT date_bin(INTERVAL '1 hour', evaluated_at, %s) AS hour,
                          COUNT(*), COUNT(*) FILTER (WHERE decision <> 'ACCEPT')
                   FROM decisions WHERE evaluated_at >= %s AND evaluated_at < %s
                   GROUP BY hour ORDER BY hour""",
                (from_date, from_date, to_date),
            )
            counts = {row[0]: (row[1], row[2]) for row in cursor.fetchall()}
    hours: list[DecisionSummaryHourly] = []
    current = from_date
    while current < to_date:
        bucket = current
        total, not_accepted = counts.get(bucket, (0, 0))
        hours.append(DecisionSummaryHourly(hour=bucket, total=total, notAccepted=not_accepted))
        current += timedelta(hours=1)
    return DecisionSummaryRecord(
        **{"from": from_date, "to": to_date, "total": sum(by_decision.values()),
           "byDecision": by_decision, "hourly": hours}
    )


@app.post(
    "/internal/v1/decisions",
    response_model=DecisionRecord,
    response_model_exclude_none=True,
    status_code=201,
)
def save_decision(payload: DecisionSaveRequest) -> DecisionRecord:
    decision = payload.decision

    try:
        with connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO decisions (
                        decision_id, request_id, score, decision,
                        reason_code, reason_message, matched_rule_ids,
                        evidence_ids, scan_id, policy_key, policy_version,
                        judgment_id, policy_hash, assessment_ids, feed_snapshot_id,
                        feed_evidence_ids, previous_decision_id,
                        trigger_snapshot_id,
                        ecosystem, package_name, package_version,
                        artifact_hash_256, artifact_hash_512, evaluated_at
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s
                    )
                    ON CONFLICT (decision_id) DO NOTHING
                    RETURNING id
                    """,
                    (
                        decision.decisionId,
                        decision.requestId,
                        decision.score,
                        decision.decision,
                        decision.reasonCode,
                        decision.reason,
                        decision.matchedRuleIds,
                        decision.evidenceIds,
                        decision.scanId,
                        payload.policyKey,
                        decision.policyVersion,
                        decision.judgmentId,
                        decision.policyHash,
                        decision.assessmentIds,
                        decision.feedSnapshotId,
                        decision.feedEvidenceIds,
                        decision.previousDecisionId,
                        decision.triggerSnapshotId,
                        decision.subject.ecosystem,
                        decision.subject.packageName,
                        decision.subject.packageVersion,
                        decision.subject.artifactHash256,
                        decision.subject.artifactHash512,
                        decision.evaluatedAt,
                    ),
                )
                inserted = cursor.fetchone()
                if inserted is None:
                    # 동일한 decisionId로 재시도한 요청은 기존 결과를
                    # 반환해 Policy Engine의 저장 요청을 멱등적으로 처리한다.
                    cursor.execute(
                        """SELECT id, request_id, scan_id, ecosystem, package_name,
                                  package_version, artifact_hash_256, artifact_hash_512
                           FROM decisions WHERE decision_id = %s FOR UPDATE""",
                        (decision.decisionId,),
                    )
                    existing = cursor.fetchone()
                    if existing is None:
                        raise RuntimeError(
                            "Decision conflict could not be resolved."
                        )
                    existing_identity = existing[1:]
                    requested_identity = (
                        decision.requestId,
                        decision.scanId,
                        decision.subject.ecosystem,
                        decision.subject.packageName,
                        decision.subject.packageVersion,
                        decision.subject.artifactHash256,
                        decision.subject.artifactHash512,
                    )
                    if existing_identity != requested_identity:
                        raise HTTPException(
                            status_code=409,
                            detail={
                                "code": "DECISION_ID_CONFLICT",
                                "message": "The decisionId is already assigned to a different package scan.",
                            },
                        )
                    decision_id = existing[0]
                else:
                    decision_id = inserted[0]
                if payload.reevaluationJobId is not None:
                    # Decision insertion and the terminal Job transition share
                    # this transaction. A failed transition rolls back both.
                    _complete_reevaluation_job(cursor, payload.reevaluationJobId)
                cursor.execute(SELECT_COLUMNS + " WHERE id = %s", (decision_id,))
                row = cursor.fetchone()
    except UniqueViolation as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "DECISION_CONFLICT",
                "message": "Decision persistence conflicted with an existing database constraint.",
            },
        ) from exc

    return _record_from_row(row)


@app.post(
    "/internal/v1/llm-judgments",
    response_model=PolicyLlmJudgmentRecord,
    response_model_exclude_none=True,
    status_code=201,
)
def save_llm_judgment(payload: PolicyLlmJudgmentSaveRequest) -> PolicyLlmJudgmentRecord:
    audit = payload.audit
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                INSERT INTO policy_llm_judgments (
                    run_mode, request_id, scan_id, policy_key, policy_version,
                    policy_hash, provider, prompt_version, input_hash, judgment_id, status, prompt, model,
                    provider_request_id, duration_ms, judgment_json, response_json,
                    failure_code, resolved_decision, resolved_reason_code,
                    shadow_of_judgment_id, comparison_json, evaluated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, COALESCE(%s, CURRENT_TIMESTAMP))
                ON CONFLICT (request_id, run_mode, judgment_id) DO NOTHING
                RETURNING id
                """,
                (
                    audit.runMode, audit.requestId, audit.scanId, audit.policyKey,
                    audit.policyVersion, audit.policyHash, audit.provider, audit.promptVersion, audit.inputHash,
                    audit.judgmentId, audit.status, audit.prompt, audit.model, audit.providerRequestId, audit.durationMs,
                    Jsonb(audit.judgmentJson) if audit.judgmentJson is not None else None,
                    Jsonb(audit.responseJson) if audit.responseJson is not None else None,
                    audit.failureCode, audit.resolvedDecision, audit.resolvedReasonCode,
                    audit.shadowOfJudgmentId,
                    Jsonb(audit.comparison) if audit.comparison is not None else None,
                    audit.evaluatedAt,
                ),
            )
            inserted = cursor.fetchone()
            if inserted is None:
                cursor.execute(
                    """SELECT id FROM policy_llm_judgments
                       WHERE request_id = %s AND run_mode = %s AND judgment_id = %s""",
                    (audit.requestId, audit.runMode, audit.judgmentId),
                )
                existing = cursor.fetchone()
                if existing is None:
                    raise RuntimeError("Policy LLM judgment conflict could not be resolved.")
                judgment_id = existing[0]
            else:
                judgment_id = inserted[0]
            cursor.execute(LLM_JUDGMENT_COLUMNS + " WHERE id = %s", (judgment_id,))
            row = cursor.fetchone()
    return _llm_judgment_from_row(row)


@app.get(
    "/internal/v1/llm-judgments/{id}",
    response_model=PolicyLlmJudgmentRecord,
    response_model_exclude_none=True,
)
def get_llm_judgment(id: UUID) -> PolicyLlmJudgmentRecord:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(LLM_JUDGMENT_COLUMNS + " WHERE id = %s", (id,))
            row = cursor.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "POLICY_LLM_JUDGMENT_NOT_FOUND"})
    return _llm_judgment_from_row(row)


@app.post(
    "/internal/v1/feed-lookups",
    response_model=FeedPersistenceResponse,
    status_code=201,
)
def save_feed_lookup(payload: FeedPersistenceRequest) -> FeedPersistenceResponse:
    attempt = payload.attempt
    stage = "ATTEMPT"
    try:
        with connect() as connection:
            with connection.cursor() as cursor:
                # Serialize retries for one request before checking the unique key.
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                    (f"feed-attempt:{attempt.requestId}",),
                )
                cursor.execute(
                    "SELECT id, snapshot_id FROM feed_lookup_attempts WHERE request_id = %s",
                    (attempt.requestId,),
                )
                existing_attempt = cursor.fetchone()
                if existing_attempt is not None:
                    return FeedPersistenceResponse(
                        attemptId=existing_attempt[0],
                        snapshotId=existing_attempt[1],
                        snapshotReused=True,
                    )

                snapshot_id = None
                snapshot_reused = False
                content_changed = False
                previous_snapshot_id = None
                reevaluation_job_ids: list[UUID] = []
                if payload.snapshot is not None:
                    stage = "SNAPSHOT"
                    snapshot = payload.snapshot
                    reuse_key = ":".join(
                        (
                            snapshot.ecosystem,
                            snapshot.packageName,
                            snapshot.packageVersion,
                            snapshot.source,
                        )
                    )
                    cursor.execute(
                        "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                        (f"feed-snapshot:{reuse_key}",),
                    )
                    cursor.execute(
                        """
                        WITH latest AS (
                            SELECT id, content_digest
                            FROM feed_snapshots
                            WHERE ecosystem = %s AND package_name = %s
                              AND package_version = %s AND source = %s
                            ORDER BY validated_at DESC, created_at DESC
                            LIMIT 1
                        ), same_digest AS (
                            SELECT id, content_digest
                            FROM feed_snapshots
                            WHERE ecosystem = %s AND package_name = %s
                              AND package_version = %s AND source = %s
                              AND content_digest = %s
                              AND expires_at > GREATEST(%s, CURRENT_TIMESTAMP)
                            ORDER BY validated_at DESC, created_at DESC
                            LIMIT 1
                        )
                        SELECT same_digest.id, same_digest.content_digest,
                               latest.id, latest.content_digest
                        FROM same_digest
                        FULL OUTER JOIN latest ON TRUE
                        """,
                        (
                            snapshot.ecosystem,
                            snapshot.packageName,
                            snapshot.packageVersion,
                            snapshot.source,
                            snapshot.ecosystem,
                            snapshot.packageName,
                            snapshot.packageVersion,
                            snapshot.source,
                            snapshot.contentDigest,
                            snapshot.validatedAt,
                        ),
                    )
                    reuse_row = cursor.fetchone()
                    if reuse_row is not None and reuse_row[0] is not None:
                        snapshot_id = reuse_row[0]
                        snapshot_reused = True
                    else:
                        cursor.execute(
                            """
                            INSERT INTO feed_snapshots (
                                ecosystem, package_name, package_version, source,
                                raw_advisories, validation_result, content_digest,
                                collected_at, validated_at, expires_at
                            )
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s,
                                    %s + INTERVAL '1 hour')
                            RETURNING id
                            """,
                            (
                                snapshot.ecosystem,
                                snapshot.packageName,
                                snapshot.packageVersion,
                                snapshot.source,
                                Jsonb(snapshot.rawAdvisories),
                                Jsonb(snapshot.validationResult),
                                snapshot.contentDigest,
                                snapshot.collectedAt,
                                snapshot.validatedAt,
                                snapshot.validatedAt,
                            ),
                        )
                        snapshot_id = cursor.fetchone()[0]

                    if reuse_row is not None and len(reuse_row) >= 4:
                        latest_id, latest_digest = reuse_row[2], reuse_row[3]
                        if latest_id is not None and latest_id != snapshot_id:
                            previous_snapshot_id = latest_id
                            content_changed = latest_digest != snapshot.contentDigest

                    if content_changed and previous_snapshot_id is not None:
                        cursor.execute(
                            """
                            INSERT INTO reevaluation_jobs (
                                ecosystem, package_name, package_version,
                                artifact_hash_256, artifact_hash_512, scan_id,
                                previous_snapshot_id, trigger_snapshot_id,
                                previous_decision_id, change_reason
                            )
                            SELECT d.ecosystem, d.package_name, d.package_version,
                                   d.artifact_hash_256, d.artifact_hash_512, d.scan_id,
                                   d.feed_snapshot_id, %s, d.decision_id,
                                   'CONTENT_DIGEST_CHANGED'
                            FROM decisions d
                            WHERE d.feed_snapshot_id = %s
                              AND d.ecosystem = %s
                              AND d.package_name = %s
                              AND d.package_version = %s
                            ON CONFLICT (previous_decision_id, trigger_snapshot_id)
                            DO NOTHING
                            RETURNING id
                            """,
                            (
                                snapshot_id,
                                previous_snapshot_id,
                                snapshot.ecosystem,
                                snapshot.packageName,
                                snapshot.packageVersion,
                            ),
                        )
                        reevaluation_job_ids = [row[0] for row in cursor.fetchall()]

                stage = "ATTEMPT"
                cursor.execute(
                    """
                    INSERT INTO feed_lookup_attempts (
                        request_id, scan_id, ecosystem, package_name,
                        package_version, source, feed_status, complete, error_code,
                        skipped_reason, pages_fetched, started_at, completed_at,
                        failure_detail, snapshot_id
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                            %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (
                        attempt.requestId,
                        attempt.scanId,
                        attempt.ecosystem,
                        attempt.packageName,
                        attempt.packageVersion,
                        attempt.source,
                        attempt.feedStatus,
                        attempt.complete,
                        attempt.errorCode,
                        attempt.skippedReason,
                        attempt.pagesFetched,
                        attempt.startedAt,
                        attempt.completedAt,
                        attempt.failureDetail,
                        snapshot_id,
                    ),
                )
                attempt_id = cursor.fetchone()[0]
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": f"FEED_{stage}_PERSISTENCE_FAILED",
                "message": f"Feed {stage.lower()} persistence failed.",
            },
        ) from exc

    return FeedPersistenceResponse(
        attemptId=attempt_id,
        snapshotId=snapshot_id,
        snapshotReused=snapshot_reused,
        contentChanged=content_changed,
        previousSnapshotId=previous_snapshot_id,
        reevaluationJobIds=reevaluation_job_ids,
    )


@app.get(
    "/internal/v1/feed-snapshots/lookup",
    response_model=FeedSnapshotRecord,
    response_model_exclude_none=True,
)
def lookup_feed_snapshot(
    source: Literal["OSV"] = "OSV",
    ecosystem: Literal["npm"] = "npm",
    packageName: str = "",
    packageVersion: str = "",
) -> FeedSnapshotRecord:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, ecosystem, package_name, package_version, source,
                       raw_advisories, validation_result, content_digest,
                       collected_at, validated_at, expires_at
                FROM feed_snapshots
                WHERE source = %s
                  AND ecosystem = %s
                  AND package_name = %s
                  AND package_version = %s
                ORDER BY validated_at DESC
                LIMIT 1
                """,
                (source, ecosystem, packageName, packageVersion),
            )
            row = cursor.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "FEED_SNAPSHOT_NOT_FOUND"})
    return FeedSnapshotRecord(
        id=row[0], ecosystem=row[1], packageName=row[2], packageVersion=row[3], source=row[4],
        rawAdvisories=row[5], validationResult=row[6], contentDigest=row[7], collectedAt=row[8],
        validatedAt=row[9], expiresAt=row[10],
    )


@app.get(
    "/internal/v1/feed-snapshots/refresh-candidates",
    response_model=list[FeedRefreshCandidate],
)
def list_feed_refresh_candidates(
    source: Literal["OSV"] = "OSV",
    since: datetime | None = None,
) -> list[FeedRefreshCandidate]:
    requested_since = since or datetime.now(timezone.utc).replace(microsecond=0)
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                WITH requested AS (
                    SELECT ecosystem, package_name, package_version,
                           MAX(completed_at) AS last_requested_at
                    FROM feed_lookup_attempts
                    WHERE source = %s AND completed_at >= %s
                    GROUP BY ecosystem, package_name, package_version
                )
                SELECT r.ecosystem, r.package_name, r.package_version,
                       r.last_requested_at
                FROM requested r
                WHERE NOT EXISTS (
                    SELECT 1 FROM feed_snapshots s
                    WHERE s.source = %s
                      AND s.ecosystem = r.ecosystem
                      AND s.package_name = r.package_name
                      AND s.package_version = r.package_version
                      AND s.expires_at > CURRENT_TIMESTAMP
                )
                ORDER BY r.last_requested_at ASC
                """,
                (source, requested_since, source),
            )
            rows = cursor.fetchall()
    return [FeedRefreshCandidate(source=source, ecosystem=row[0], packageName=row[1], packageVersion=row[2], lastRequestedAt=row[3]) for row in rows]


@app.get(
    "/internal/v1/feed-snapshots/{snapshot_id}",
    response_model=FeedSnapshotRecord,
    response_model_exclude_none=True,
)
def get_feed_snapshot(snapshot_id: UUID) -> FeedSnapshotRecord:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, ecosystem, package_name, package_version, source,
                       raw_advisories, validation_result, content_digest,
                       collected_at, validated_at, expires_at
                FROM feed_snapshots WHERE id = %s
                """,
                (snapshot_id,),
            )
            row = cursor.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "FEED_SNAPSHOT_NOT_FOUND"})
    return FeedSnapshotRecord(
        id=row[0], ecosystem=row[1], packageName=row[2], packageVersion=row[3], source=row[4],
        rawAdvisories=row[5], validationResult=row[6], contentDigest=row[7], collectedAt=row[8],
        validatedAt=row[9], expiresAt=row[10],
    )


@app.get(
    "/internal/v1/reevaluation-jobs/{job_id}",
    response_model=ReevaluationJobRecord,
    response_model_exclude_none=True,
)
def get_reevaluation_job(job_id: UUID) -> ReevaluationJobRecord:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(REEVALUATION_JOB_COLUMNS + " WHERE id = %s", (job_id,))
            row = cursor.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "REEVALUATION_JOB_NOT_FOUND"})
    return _reevaluation_job_from_row(row)


@app.post(
    "/internal/v1/reevaluation-jobs/{job_id}/claim",
    response_model=ReevaluationJobClaimResponse,
    response_model_exclude_none=True,
)
def claim_reevaluation_job(job_id: UUID) -> ReevaluationJobClaimResponse:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(REEVALUATION_JOB_COLUMNS + " WHERE id = %s FOR UPDATE", (job_id,))
            row = cursor.fetchone()
            if row is None:
                raise HTTPException(status_code=404, detail={"code": "REEVALUATION_JOB_NOT_FOUND"})
            if row[11] == "QUEUED":
                cursor.execute(
                    """UPDATE reevaluation_jobs
                       SET status = 'RUNNING', started_at = CURRENT_TIMESTAMP
                       WHERE id = %s""",
                    (job_id,),
                )
                _record_job_event(cursor, job_id, "QUEUED", "RUNNING")
                cursor.execute(REEVALUATION_JOB_COLUMNS + " WHERE id = %s", (job_id,))
                row = cursor.fetchone()
            return ReevaluationJobClaimResponse(
                claimed=row[11] == "RUNNING",
                job=_reevaluation_job_from_row(row),
            )


@app.post(
    "/internal/v1/reevaluation-jobs/{job_id}/fail",
    response_model=ReevaluationJobRecord,
    response_model_exclude_none=True,
)
def fail_reevaluation_job(job_id: UUID, payload: ReevaluationJobFailure) -> ReevaluationJobRecord:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT status FROM reevaluation_jobs WHERE id = %s FOR UPDATE",
                (job_id,),
            )
            current = cursor.fetchone()
            if current is None:
                raise HTTPException(status_code=404, detail={"code": "REEVALUATION_JOB_NOT_FOUND"})
            if current[0] not in ("COMPLETED", "FAILED"):
                cursor.execute(
                    """UPDATE reevaluation_jobs
                       SET status = 'FAILED', completed_at = CURRENT_TIMESTAMP,
                           error_code = %s, error_detail = %s
                       WHERE id = %s""",
                    (payload.errorCode, payload.errorDetail, job_id),
                )
                _record_job_event(cursor, job_id, current[0], "FAILED", payload.errorCode, payload.errorDetail)
            cursor.execute(REEVALUATION_JOB_COLUMNS + " WHERE id = %s", (job_id,))
            row = cursor.fetchone()
    return _reevaluation_job_from_row(row)


@app.get(
    "/internal/v1/decisions/by-decision-id/{decision_id}",
    response_model=DecisionRecord,
    response_model_exclude_none=True,
)
def get_decision_by_decision_id(decision_id: str) -> DecisionRecord:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(SELECT_COLUMNS + " WHERE decision_id = %s", (decision_id,))
            row = cursor.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail={"code": "DECISION_NOT_FOUND"})
    return _record_from_row(row)


@app.get(
    "/internal/v1/decisions/{id}",
    response_model=DecisionRecord,
    response_model_exclude_none=True,
    summary="Get a Decision DB record by internal UUID",
    description=(
        "Retrieves a Decision DB record by its internal PostgreSQL UUID primary key. "
        "The external decisionId value such as dec_xxx is not used for this endpoint."
    ),
)
def get_decision(id: UUID) -> DecisionRecord:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(SELECT_COLUMNS + " WHERE id = %s", (id,))
            row = cursor.fetchone()

    if row is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DECISION_NOT_FOUND",
                "message": "Decision was not found.",
            },
        )

    return _record_from_row(row)
