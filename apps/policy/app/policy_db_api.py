from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from fastapi.encoders import jsonable_encoder

from .policy_db import connect


class PolicyConditions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    when: dict[str, Any] | None = None
    minimumSupport: Literal["SUPPORTED", "PARTIAL"] | None = None
    onUnknown: Literal["HOLD", "REVIEW", "IGNORE"] | None = None


class PolicyRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ruleId: str
    name: str | None = None
    decision: Literal["ACCEPT", "REJECT", "HOLD", "REVIEW"]
    reasonCode: str
    reason: str
    priority: int = 0
    conditions: PolicyConditions = Field(default_factory=PolicyConditions)


class PolicyPredicateDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    description: str
    category: str | None = None
    requiresFeedEvidence: bool = False
    rejectAllowed: bool = True


class PolicyDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")

    policyKey: str
    policyVersion: str
    ecosystem: Literal["npm"]
    rules: list[PolicyRule]
    predicates: list[PolicyPredicateDefinition] = Field(default_factory=list)

PolicyStatus = Literal["DRAFT", "PUBLISHED", "ARCHIVED"]
DecisionType = Literal["ACCEPT", "REJECT", "HOLD", "REVIEW"]
RuleKind = Literal["HARD", "CHAIN"]


class PolicyRuleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ruleCode: str
    ruleKind: RuleKind
    name: str
    description: str | None = None
    enabled: bool = True
    decision: DecisionType
    priority: int = 0
    conditions: PolicyConditions = Field(default_factory=PolicyConditions)
    reasonCode: str
    reasonMessage: str


class PolicyCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    policyKey: str
    name: str
    description: str | None = None
    ecosystem: Literal["npm"] = "npm"
    version: str
    createdBy: str
    updatedBy: str
    createdByUserId: UUID | None = None
    updatedByUserId: UUID | None = None
    rules: list[PolicyRuleCreate] = Field(default_factory=list)


class PolicyVersionSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    policyKey: str
    name: str
    ecosystem: Literal["npm"]
    version: str
    status: PolicyStatus
    createdBy: str
    updatedBy: str
    createdByUserId: UUID | None = None
    updatedByUserId: UUID | None = None
    publishedAt: datetime | None = None
    createdAt: datetime
    updatedAt: datetime


class PolicyVersionListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    policyKey: str
    versions: list[PolicyVersionSummary]

class PolicyVersionDetail(PolicyVersionSummary):
    rules: list[PolicyRuleCreate] = Field(default_factory=list)

class PolicyPublishRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    updatedBy: str
    updatedByUserId: UUID | None = None


class PolicyPublishResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    policyKey: str
    version: str
    status: Literal["PUBLISHED"]
    publishedAt: datetime
    updatedBy: str
    updatedByUserId: UUID | None = None


class DashboardRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ruleCode: str = Field(pattern=r"^[A-Z0-9][A-Z0-9_-]{0,63}$")
    name: str = Field(min_length=1, max_length=255)
    decision: DecisionType
    priority: int = Field(ge=1, le=100)
    enabled: bool = True
    matchAll: bool
    conditions: list[str] = Field(min_length=1)
    minimumSupport: Literal["SUPPORTED", "PARTIAL"] = "SUPPORTED"
    onUnknown: Literal["HOLD", "REVIEW", "IGNORE"] = "HOLD"

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name must not be blank")
        return value

    @model_validator(mode="after")
    def validate_conditions(self) -> "DashboardRule":
        if len(self.conditions) != len(set(self.conditions)):
            raise ValueError("conditions must not contain duplicates")
        return self


class DashboardApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    baseVersion: str = Field(min_length=1)
    version: str = Field(min_length=1)
    createdBy: str = Field(min_length=1)
    createdByUserId: UUID | None = None
    rules: list[DashboardRule]

    @model_validator(mode="after")
    def validate_priorities(self) -> "DashboardApplyRequest":
        priorities = [rule.priority for rule in self.rules]
        if len(priorities) != len(set(priorities)):
            raise ValueError("Rule priorities must be unique.")
        rule_codes = [rule.ruleCode for rule in self.rules]
        if len(rule_codes) != len(set(rule_codes)):
            raise ValueError("Rule codes must be unique.")
        return self


class DashboardApplyResponse(BaseModel):
    policyKey: str
    version: str
    status: Literal["PUBLISHED"]
    publishedAt: datetime


class PredicateListItem(BaseModel):
    code: str
    description: str
    category: str
    requiresFeedEvidence: bool
    rejectAllowed: bool


class PredicateListResponse(BaseModel):
    predicates: list[PredicateListItem]
app = FastAPI(title="WHS Policy DB API", version="0.1.0")


@app.exception_handler(RequestValidationError)
async def policy_request_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    if request.method == "POST" and request.url.path.startswith("/internal/v1/policies/") and request.url.path.endswith("/versions"):
        return JSONResponse(
            status_code=422,
            content=jsonable_encoder({"detail": {"code": "INVALID_POLICY_RULE", "message": "The policy version payload is invalid.", "errors": exc.errors()}}),
        )
    return JSONResponse(status_code=422, content=jsonable_encoder({"detail": exc.errors()}))


@app.get("/health")
def health() -> dict[str, str]:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    return {"status": "ok", "service": "policy-db-api"}

@app.post(
    "/internal/v1/policies",
    response_model=PolicyVersionSummary,
    status_code=201,
)
def create_policy(payload: PolicyCreateRequest) -> PolicyVersionSummary:
    try:
        with connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO policies (
                        policy_key,
                        name,
                        description,
                        ecosystem,
                        version,
                        status,
                        created_by,
                        updated_by,
                        created_by_user_id,
                        updated_by_user_id
                    )
                    VALUES (%s, %s, %s, %s, %s, 'DRAFT', %s, %s, %s, %s)
                    RETURNING
                        id,
                        policy_key,
                        name,
                        ecosystem,
                        version,
                        status,
                        created_by,
                        updated_by,
                        created_by_user_id,
                        updated_by_user_id,
                        published_at,
                        created_at,
                        updated_at
                    """,
                    (
                        payload.policyKey,
                        payload.name,
                        payload.description,
                        payload.ecosystem,
                        payload.version,
                        payload.createdBy,
                        payload.updatedBy,
                        payload.createdByUserId,
                        payload.updatedByUserId,
                    ),
                )
                policy_row = cursor.fetchone()

                policy_id = policy_row[0]

                for rule in payload.rules:
                    cursor.execute(
                        """
                        INSERT INTO policy_rules (
                            policy_id,
                            rule_code,
                            rule_kind,
                            name,
                            description,
                            enabled,
                            decision,
                            priority,
                            condition_json,
                            reason_code,
                            reason_message
                        )
                        VALUES (
                            %s, %s, %s, %s, %s, %s, %s, %s,
                            %s, %s, %s
                        )
                        """,
                        (
                            policy_id,
                            rule.ruleCode,
                            rule.ruleKind,
                            rule.name,
                            rule.description,
                            rule.enabled,
                            rule.decision,
                            rule.priority,
                            Jsonb(rule.conditions.model_dump()),
                            rule.reasonCode,
                            rule.reasonMessage,
                        ),
                    )

    except UniqueViolation as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "POLICY_VERSION_ALREADY_EXISTS",
                "message": "The policy version already exists.",
            },
        ) from exc

    return PolicyVersionSummary(
        id=policy_row[0],
        policyKey=policy_row[1],
        name=policy_row[2],
        ecosystem=policy_row[3],
        version=policy_row[4],
        status=policy_row[5],
        createdBy=policy_row[6],
        updatedBy=policy_row[7],
        createdByUserId=policy_row[8],
        updatedByUserId=policy_row[9],
        publishedAt=policy_row[10],
        createdAt=policy_row[11],
        updatedAt=policy_row[12],
    )

@app.get(
    "/internal/v1/policies/{policy_key}/versions",
    response_model=PolicyVersionListResponse,
)
def list_policy_versions(policy_key: str) -> PolicyVersionListResponse:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    id,
                    policy_key,
                    name,
                    ecosystem,
                    version,
                    status,
                    created_by,
                    updated_by,
                    created_by_user_id,
                    updated_by_user_id,
                    published_at,
                    created_at,
                    updated_at
                FROM policies
                WHERE policy_key = %s
                ORDER BY created_at DESC, version DESC
                """,
                (policy_key,),
            )
            rows = cursor.fetchall()

    if not rows:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "POLICY_NOT_FOUND",
                "message": "No policy versions were found.",
            },
        )

    return PolicyVersionListResponse(
        policyKey=policy_key,
        versions=[
            PolicyVersionSummary(
                id=row[0],
                policyKey=row[1],
                name=row[2],
                ecosystem=row[3],
                version=row[4],
                status=row[5],
                createdBy=row[6],
                updatedBy=row[7],
                createdByUserId=row[8],
                updatedByUserId=row[9],
                publishedAt=row[10],
                createdAt=row[11],
                updatedAt=row[12],
            )
            for row in rows
        ],
    )


def _dashboard_rule_create(rule: DashboardRule, known_predicates: dict[str, tuple[str, bool, bool]]) -> PolicyRuleCreate:
    unknown = [code for code in rule.conditions if code not in known_predicates]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail={"code": "UNKNOWN_POLICY_PREDICATE", "message": "A rule references an unknown predicate.", "predicates": sorted(unknown)},
        )
    forbidden = [code for code in rule.conditions if rule.decision == "REJECT" and not known_predicates[code][1]]
    if forbidden:
        raise HTTPException(
            status_code=422,
            detail={"code": "INVALID_POLICY_RULE", "message": "REJECT rules cannot use predicates that are not allowed to reject.", "predicates": sorted(forbidden)},
        )
    group = "allOf" if rule.matchAll else "anyOf"
    return PolicyRuleCreate(
        ruleCode=rule.ruleCode,
        ruleKind="HARD",
        name=rule.name,
        description=None,
        enabled=rule.enabled,
        decision=rule.decision,
        priority=rule.priority,
        conditions=PolicyConditions(
            when={group: [{"predicate": code} for code in rule.conditions]},
            minimumSupport=rule.minimumSupport,
            onUnknown=rule.onUnknown,
        ),
        reasonCode=rule.ruleCode,
        reasonMessage=rule.name,
    )


@app.post(
    "/internal/v1/policies/{policy_key}/versions",
    response_model=DashboardApplyResponse,
    status_code=201,
)
def create_and_publish_dashboard_version(
    policy_key: str,
    payload: DashboardApplyRequest,
) -> DashboardApplyResponse:
    try:
        with connect() as connection:
            with connection.cursor() as cursor:
                # Serialize all npm policy activations, including the no-active-policy case.
                cursor.execute("SELECT pg_advisory_xact_lock(hashtext('whs-policy-publish:npm'))")
                cursor.execute(
                    """SELECT policy_key, version FROM policies
                       WHERE ecosystem = 'npm' AND status = 'PUBLISHED'
                       ORDER BY published_at DESC NULLS LAST, updated_at DESC
                       LIMIT 1 FOR UPDATE"""
                )
                active = cursor.fetchone()
                if active is None or active[0] != policy_key or active[1] != payload.baseVersion:
                    raise HTTPException(
                        status_code=409,
                        detail={"code": "POLICY_CHANGED", "message": "The active policy changed since editing began."},
                    )

                cursor.execute(
                    """SELECT code, reject_allowed, requires_feed_evidence
                       FROM policy_predicates WHERE enabled = TRUE"""
                )
                known_predicates = {row[0]: (row[0], row[1], row[2]) for row in cursor.fetchall()}
                rules = [_dashboard_rule_create(rule, known_predicates) for rule in payload.rules]

                cursor.execute(
                    """UPDATE policies SET status = 'ARCHIVED', updated_by = %s,
                           updated_by_user_id = %s, updated_at = CURRENT_TIMESTAMP
                       WHERE ecosystem = 'npm' AND status = 'PUBLISHED'""",
                    (payload.createdBy, payload.createdByUserId),
                )
                cursor.execute(
                    """INSERT INTO policies (
                           policy_key, name, description, ecosystem, version, status,
                           created_by, updated_by, created_by_user_id, updated_by_user_id,
                           published_at
                       )
                       SELECT policy_key, name, description, ecosystem, %s, 'PUBLISHED',
                              %s, %s, %s, %s, CURRENT_TIMESTAMP
                       FROM policies WHERE policy_key = %s AND version = %s
                       RETURNING policy_key, version, status, published_at""",
                    (payload.version, payload.createdBy, payload.createdBy, payload.createdByUserId,
                     payload.createdByUserId, policy_key, payload.baseVersion),
                )
                published = cursor.fetchone()
                if published is None:
                    raise HTTPException(status_code=409, detail={"code": "POLICY_CHANGED", "message": "The base policy version was not found."})
                new_policy_key, new_version, status, published_at = published
                cursor.execute("SELECT id FROM policies WHERE policy_key = %s AND version = %s", (new_policy_key, new_version))
                policy_id = cursor.fetchone()[0]
                for rule in rules:
                    cursor.execute(
                        """INSERT INTO policy_rules (
                               policy_id, rule_code, rule_kind, name, description, enabled,
                               decision, priority, condition_json, reason_code, reason_message
                           ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                        (policy_id, rule.ruleCode, rule.ruleKind, rule.name, rule.description,
                         rule.enabled, rule.decision, rule.priority, Jsonb(rule.conditions.model_dump(exclude_none=True)),
                         rule.reasonCode, rule.reasonMessage),
                    )
    except UniqueViolation as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "POLICY_VERSION_ALREADY_EXISTS", "message": "The policy version already exists."},
        ) from exc

    return DashboardApplyResponse(policyKey=new_policy_key, version=new_version, status=status, publishedAt=published_at)


@app.get("/internal/v1/predicates", response_model=PredicateListResponse)
def list_predicates() -> PredicateListResponse:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """SELECT code, description, category, requires_feed_evidence, reject_allowed
                   FROM policy_predicates WHERE enabled = TRUE ORDER BY code ASC"""
            )
            rows = cursor.fetchall()
    return PredicateListResponse(predicates=[
        PredicateListItem(code=row[0], description=row[1], category=row[2], requiresFeedEvidence=row[3], rejectAllowed=row[4])
        for row in rows
    ])

@app.get(
    "/internal/v1/policies/{policy_key}/versions/{version}",
    response_model=PolicyVersionDetail,
)
def get_policy_version(
    policy_key: str,
    version: str,
) -> PolicyVersionDetail:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    id,
                    policy_key,
                    name,
                    ecosystem,
                    version,
                    status,
                    created_by,
                    updated_by,
                    created_by_user_id,
                    updated_by_user_id,
                    published_at,
                    created_at,
                    updated_at
                FROM policies
                WHERE policy_key = %s AND version = %s
                """,
                (policy_key, version),
            )
            policy_row = cursor.fetchone()

            if policy_row is None:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "code": "POLICY_VERSION_NOT_FOUND",
                        "message": "The policy version was not found.",
                    },
                )

            cursor.execute(
                """
                SELECT
                    rule_code,
                    rule_kind,
                    name,
                    description,
                    enabled,
                    decision,
                    priority,
                    condition_json,
                    reason_code,
                    reason_message
                FROM policy_rules
                WHERE policy_id = %s
                ORDER BY priority ASC, rule_code ASC
                """,
                (policy_row[0],),
            )
            rule_rows = cursor.fetchall()

    return PolicyVersionDetail(
        id=policy_row[0],
        policyKey=policy_row[1],
        name=policy_row[2],
        ecosystem=policy_row[3],
        version=policy_row[4],
        status=policy_row[5],
        createdBy=policy_row[6],
        updatedBy=policy_row[7],
        createdByUserId=policy_row[8],
        updatedByUserId=policy_row[9],
        publishedAt=policy_row[10],
        createdAt=policy_row[11],
        updatedAt=policy_row[12],
        rules=[
            PolicyRuleCreate(
                ruleCode=row[0],
                ruleKind=row[1],
                name=row[2],
                description=row[3],
                enabled=row[4],
                decision=row[5],
                priority=row[6],
                conditions=row[7] or {},
                reasonCode=row[8],
                reasonMessage=row[9],
            )
            for row in rule_rows
        ],
    )

@app.post(
    "/internal/v1/policies/{policy_key}/versions/{version}/publish",
    response_model=PolicyPublishResponse,
)
def publish_policy_version(
    policy_key: str,
    version: str,
    payload: PolicyPublishRequest,
) -> PolicyPublishResponse:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtext('whs-policy-publish:npm'))")
            cursor.execute(
                """
                SELECT id, version, status
                FROM policies
                WHERE policy_key = %s AND version = %s
                FOR UPDATE
                """,
                (policy_key, version),
            )
            policy_row = cursor.fetchone()

            if policy_row is None:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "code": "POLICY_VERSION_NOT_FOUND",
                        "message": "The policy version was not found.",
                    },
                )

            policy_id, target_version, target_status = policy_row
            if target_status == "DRAFT":
                raise HTTPException(
                    status_code=409,
                    detail={"code": "POLICY_DRAFT_CANNOT_BE_PUBLISHED", "message": "Draft versions cannot be published."},
                )

            cursor.execute(
                """SELECT version FROM policies
                   WHERE ecosystem = 'npm' AND status = 'PUBLISHED'
                   ORDER BY published_at DESC NULLS LAST, updated_at DESC LIMIT 1 FOR UPDATE"""
            )
            active_row = cursor.fetchone()
            active_version = active_row[0] if active_row else None
            target_parts = target_version.split(".")
            active_parts = active_version.split(".") if active_version else []
            if len(target_parts) >= 3 and len(active_parts) >= 3 and target_parts[1] != active_parts[1]:
                raise HTTPException(
                    status_code=409,
                    detail={"code": "POLICY_INTERNAL_VERSION_MISMATCH", "message": "A version from another policy engine generation cannot be published."},
                )

            cursor.execute(
                """
                SELECT condition_json
                FROM policy_rules
                WHERE policy_id = %s AND enabled = TRUE
                """,
                (policy_id,),
            )
            condition_rows = cursor.fetchall()
            cursor.execute(
                "SELECT code FROM policy_predicates WHERE enabled = TRUE"
            )
            known_predicates = {row[0] for row in cursor.fetchall()}
            unknown_predicates = sorted(
                {
                    predicate
                    for (condition_json,) in condition_rows
                    for group in (condition_json or {}).get("when", {}).values()
                    if isinstance(group, list)
                    for condition in group
                    if isinstance(condition, dict)
                    for predicate in [condition.get("predicate")]
                    if isinstance(predicate, str) and predicate not in known_predicates
                }
            )
            if unknown_predicates:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "UNKNOWN_POLICY_PREDICATE",
                        "predicates": unknown_predicates,
                    },
                )

            cursor.execute(
                """
                UPDATE policies
                SET
                    status = 'ARCHIVED',
                    updated_by = %s,
                    updated_by_user_id = %s,
                    updated_at = CURRENT_TIMESTAMP
                WHERE ecosystem = 'npm'
                  AND status = 'PUBLISHED'
                  AND id <> %s
                """,
                (payload.updatedBy, payload.updatedByUserId, policy_id),
            )

            cursor.execute(
                """
                UPDATE policies
                SET
                    status = 'PUBLISHED',
                    published_at = CURRENT_TIMESTAMP,
                    updated_by = %s,
                    updated_by_user_id = %s,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
                RETURNING
                    policy_key,
                    version,
                    status,
                    published_at,
                    updated_by,
                    updated_by_user_id
                """,
                (payload.updatedBy, payload.updatedByUserId, policy_id),
            )
            published_row = cursor.fetchone()

    return PolicyPublishResponse(
        policyKey=published_row[0],
        version=published_row[1],
        status=published_row[2],
        publishedAt=published_row[3],
        updatedBy=published_row[4],
        updatedByUserId=published_row[5],
    )

@app.get("/internal/v1/policies/active", response_model=PolicyDocument)
def get_active_policy() -> PolicyDocument:
    with connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, policy_key, version, ecosystem
                FROM policies
                WHERE ecosystem = 'npm' AND status = 'PUBLISHED'
                ORDER BY published_at DESC NULLS LAST, updated_at DESC
                LIMIT 1
                """
            )
            policy = cursor.fetchone()

            if policy is None:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "code": "ACTIVE_POLICY_NOT_FOUND",
                        "message": "No published npm policy exists.",
                    },
                )

            policy_id, policy_key, version, ecosystem = policy
            cursor.execute(
                """
                SELECT rule_code, name, decision, priority, condition_json,
                       reason_code, reason_message
                FROM policy_rules
                WHERE policy_id = %s AND enabled = TRUE
                ORDER BY priority ASC, rule_code ASC
                """,
                (policy_id,),
            )
            rules = cursor.fetchall()
            cursor.execute(
                """
                SELECT code, description, category, requires_feed_evidence,
                       reject_allowed
                FROM policy_predicates
                WHERE enabled = TRUE
                ORDER BY code ASC
                """
            )
            predicates = cursor.fetchall()

    return PolicyDocument(
        policyKey=policy_key,
        policyVersion=version,
        ecosystem=ecosystem,
        rules=[
            PolicyRule(
                ruleId=rule_code,
                name=name,
                decision=decision,
                priority=priority,
                reasonCode=reason_code,
                reason=reason_message,
                conditions=condition_json or {},
            )
            for rule_code, name, decision, priority, condition_json, reason_code, reason_message in rules
        ],
        predicates=[
            PolicyPredicateDefinition(
                code=code,
                description=description,
                category=category,
                requiresFeedEvidence=requires_feed_evidence,
                rejectAllowed=reject_allowed,
            )
            for code, description, category, requires_feed_evidence, reject_allowed in predicates
        ],
    )
