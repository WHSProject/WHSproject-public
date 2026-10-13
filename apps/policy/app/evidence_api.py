from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from .evidence_db import connect
from .evidence_models import EvidenceV01


app = FastAPI(title="WHS Evidence DB API", version="0.1.0")


def parse_stored_evidence(raw: dict) -> EvidenceV01:
    # Earlier writes materialized omitted provenance extensions as JSON null.
    normalized = dict(raw)
    for field in ("analysisPass", "taxonomy", "action", "capabilityPreservation"):
        if normalized.get(field) is None:
            normalized.pop(field, None)
    if isinstance(normalized.get("capabilityPreservation"), dict):
        capability = dict(normalized["capabilityPreservation"])
        # Historical writes omitted the required but nullable "after" field.
        capability.setdefault("after", None)
        normalized["capabilityPreservation"] = capability
    if isinstance(normalized.get("locations"), list):
        normalized["locations"] = [dict(location) for location in normalized["locations"]]
        for location in normalized["locations"]:
            for field in ("representation", "lineageStatus", "derivedFrom"):
                if location.get(field) is None:
                    location.pop(field, None)
    return EvidenceV01.model_validate(normalized)


@app.get("/health")
def health() -> dict[str, str]:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    return {"status": "ok", "service": "evidence-db-api"}


@app.post("/internal/v1/evidences", response_model=EvidenceV01, response_model_exclude_none=True, status_code=201)
def create_evidence(evidence: EvidenceV01) -> EvidenceV01:
    raw_json = evidence.model_dump(mode="json", exclude_none=True)

    try:
        with connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO evidences (
                        evidence_id, schema_version, kind, scan_run_id,
                        ecosystem, package_name, package_version,
                        artifact_hash, signal_id, signal_type,
                        signal_category, assertion_summary,
                        assertion_basis, generated_by, observed_at, raw_json
                    )
                    VALUES (
                        %(evidence_id)s, %(schema_version)s, %(kind)s,
                        %(scan_run_id)s, %(ecosystem)s, %(package_name)s,
                        %(package_version)s, %(artifact_hash)s,
                        %(signal_id)s, %(signal_type)s,
                        %(signal_category)s, %(assertion_summary)s,
                        %(assertion_basis)s, %(generated_by)s,
                        %(observed_at)s, %(raw_json)s
                    )
                    RETURNING id
                    """,
                    {
                        "evidence_id": evidence.evidenceId,
                        "schema_version": evidence.schemaVersion,
                        "kind": evidence.kind,
                        "scan_run_id": evidence.provenance.scanId,
                        "ecosystem": evidence.subject.ecosystem,
                        "package_name": evidence.subject.packageName,
                        "package_version": evidence.subject.packageVersion,
                        "artifact_hash": evidence.subject.artifactHash,
                        "signal_id": evidence.signal.id or evidence.signal.type,
                        "signal_type": evidence.signal.type,
                        "signal_category": evidence.signal.category,
                        "assertion_summary": evidence.assertion.summary,
                        "assertion_basis": evidence.assertion.basis,
                        "generated_by": evidence.provenance.generatedBy
                        or evidence.provenance.producerType
                        or "EVIDENCE_NORMALIZER",
                        "observed_at": evidence.provenance.observedAt
                        or datetime.now(timezone.utc),
                        "raw_json": Jsonb(raw_json),
                    },
                )
                evidence_row_id = cursor.fetchone()[0]

                for source in evidence.sources:
                    cursor.execute(
                        """
                        INSERT INTO evidence_sources (
                            evidence_id, analyzer, analyzer_version,
                            rule_id, rule_version, raw_finding_id
                        )
                        VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (
                            evidence_row_id,
                            source.analyzer,
                            source.analyzerVersion,
                            source.ruleId,
                            source.ruleVersion,
                            source.rawFindingId,
                        ),
                    )

                for location in evidence.locations:
                    cursor.execute(
                        """
                        INSERT INTO evidence_locations (
                            evidence_id, location_type, path,
                            start_line, end_line, json_pointer, role
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s)
                        """,
                        (
                            evidence_row_id,
                            location.type,
                            location.path,
                            location.startLine,
                            location.endLine,
                            location.jsonPointer,
                            location.role,
                        ),
                    )

                if evidence.derivedFrom:
                    for parent_evidence_id in evidence.derivedFrom.evidenceIds:
                        cursor.execute(
                            """
                            INSERT INTO evidence_derivations (
                                evidence_id, parent_evidence_id
                            )
                            VALUES (%s, %s)
                            """,
                            (evidence_row_id, parent_evidence_id),
                        )
                    for parent_finding_id in evidence.derivedFrom.findingIds:
                        cursor.execute(
                            """
                            INSERT INTO evidence_derivations (
                                evidence_id, parent_finding_id
                            )
                            VALUES (%s, %s)
                            """,
                            (evidence_row_id, parent_finding_id),
                        )

                for limitation_code in evidence.limitations:
                    cursor.execute(
                        """
                        INSERT INTO evidence_limitations (
                            evidence_id, limitation_code
                        )
                        VALUES (%s, %s)
                        """,
                        (evidence_row_id, limitation_code),
                    )
    except UniqueViolation as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "EVIDENCE_ALREADY_EXISTS",
                "message": "Evidence ID already exists.",
            },
        ) from exc

    return evidence


@app.get("/internal/v1/evidences/by-artifact", response_model=list[EvidenceV01], response_model_exclude_none=True)
def list_evidences_by_artifact(
    ecosystem: str = "npm",
    packageName: str = "",
    packageVersion: str = "",
    artifactHash: str = "",
    scanId: str | None = None,
) -> list[EvidenceV01]:
    """Internal read contract used by feed re-evaluation.

    It returns only evidence already persisted for the exact artifact identity;
    the re-evaluation path never synthesizes an Evidence record.
    """
    query = """
        SELECT raw_json FROM evidences
        WHERE ecosystem = %s AND package_name = %s
          AND package_version = %s AND artifact_hash = %s
    """
    parameters: list[str] = [ecosystem, packageName, packageVersion, artifactHash]
    if scanId is not None:
        query += " AND scan_run_id = %s"
        parameters.append(scanId)
    query += " ORDER BY created_at, evidence_id"
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(query, parameters)
            rows = cursor.fetchall()
    return [parse_stored_evidence(row[0]) for row in rows]


@app.get("/internal/v1/evidences/{evidence_id}", response_model=EvidenceV01, response_model_exclude_none=True)
def get_evidence(evidence_id: str) -> EvidenceV01:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT raw_json FROM evidences WHERE evidence_id = %s",
                (evidence_id,),
            )
            row = cursor.fetchone()

    if row is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "EVIDENCE_NOT_FOUND",
                "message": "Evidence was not found.",
            },
        )

    return parse_stored_evidence(row[0])
