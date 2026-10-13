from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, UUID4, model_validator


class DecisionSubject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ecosystem: Literal["npm"]
    packageName: str
    packageVersion: str
    artifactHash256: str | None = None
    artifactHash512: str | None = None
    artifactHash: str | None = None
    integrity: str | None = None

    @model_validator(mode="after")
    def normalize_legacy_artifact_hash(self) -> "DecisionSubject":
        if self.integrity is not None:
            if not self.integrity.startswith("sha512-"):
                raise ValueError(
                    "integrity must use sha512-<base64> format."
                )
            if self.artifactHash512 and self.artifactHash512 != self.integrity:
                raise ValueError(
                    "integrity and artifactHash512 must contain the same value."
                )
            self.artifactHash512 = self.integrity

        if self.artifactHash:
            if self.artifactHash.startswith("sha512-"):
                if self.artifactHash512 and self.artifactHash512 != self.artifactHash:
                    raise ValueError(
                        "artifactHash and artifactHash512 must contain the same value."
                    )
                self.artifactHash512 = self.artifactHash
            elif self.artifactHash.startswith("sha256:"):
                self.artifactHash256 = self.artifactHash256 or self.artifactHash
            else:
                raise ValueError(
                    "artifactHash must use sha256:<hex> or sha512-<base64> format."
                )

        if not self.artifactHash256 and not self.artifactHash512:
            raise ValueError(
                "artifactHash256 or artifactHash512 must be provided."
            )

        return self


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    decisionId: str
    requestId: UUID
    score: float | None = None
    decision: Literal["ACCEPT", "REJECT", "HOLD", "REVIEW"]
    reasonCode: str
    reason: str
    matchedRuleIds: list[str]
    evidenceIds: list[str]
    scanId: UUID
    policyVersion: str
    judgmentId: str | None = None
    policyHash: str | None = None
    assessmentIds: list[str] = Field(default_factory=list)
    feedSnapshotId: UUID | None = None
    feedEvidenceIds: list[str] | None = None
    previousDecisionId: str | None = None
    triggerSnapshotId: UUID | None = None
    subject: DecisionSubject
    evaluatedAt: datetime


class DecisionSaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    policyKey: str
    decision: Decision
    reevaluationJobId: UUID | None = None


class PolicyLlmJudgment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runMode: Literal["PRIMARY", "SHADOW"]
    requestId: UUID
    scanId: UUID
    policyKey: str
    policyVersion: str
    policyHash: str | None = None
    provider: str | None = None
    promptVersion: str | None = None
    inputHash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    judgmentId: str
    status: Literal["COMPLETED", "FAILED"]
    prompt: str = Field(min_length=1)
    model: str | None = None
    providerRequestId: str | None = None
    durationMs: float | None = Field(default=None, ge=0)
    judgmentJson: Any | None = None
    responseJson: Any | None = None
    failureCode: str | None = None
    resolvedDecision: Literal["ACCEPT", "REJECT", "HOLD", "REVIEW"] | None = None
    resolvedReasonCode: str | None = None
    shadowOfJudgmentId: str | None = None
    comparison: dict[str, Any] | None = None
    evaluatedAt: datetime | None = None


class PolicyLlmJudgmentSaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    audit: PolicyLlmJudgment


class PolicyLlmJudgmentRecord(PolicyLlmJudgment):
    id: UUID
    createdAt: datetime


class DecisionRecord(BaseModel):
    id: UUID
    decisionId: str
    requestId: UUID
    score: float | None = None
    decision: Literal["ACCEPT", "REJECT", "HOLD", "REVIEW"]
    reasonCode: str
    reason: str
    matchedRuleIds: list[str]
    evidenceIds: list[str]
    scanId: UUID
    policyKey: str
    policyVersion: str
    judgmentId: str | None = None
    policyHash: str | None = None
    assessmentIds: list[str] = Field(default_factory=list)
    feedSnapshotId: UUID | None = None
    feedEvidenceIds: list[str] | None = None
    previousDecisionId: str | None = None
    triggerSnapshotId: UUID | None = None
    subject: DecisionSubject
    evaluatedAt: datetime
    createdAt: datetime


class DecisionPackageSummary(BaseModel):
    decisionId: str
    requestId: UUID
    packageName: str
    version: str
    decision: Literal["ACCEPT", "REJECT", "HOLD", "REVIEW"]
    evaluatedAt: datetime
    matchedRuleIds: list[str]
    policyKey: str
    policyVersion: str


class DecisionPackagesResponse(BaseModel):
    total: int
    page: int
    pageSize: int
    items: list[DecisionPackageSummary]


class DecisionPackageVersionsResponse(BaseModel):
    packageName: str
    versions: list[DecisionPackageSummary]


class DecisionSummaryHourly(BaseModel):
    hour: datetime
    total: int
    notAccepted: int


class DecisionSummaryRecord(BaseModel):
    fromDate: datetime = Field(alias="from")
    toDate: datetime = Field(alias="to")
    total: int
    byDecision: dict[Literal["ACCEPT", "REJECT", "HOLD", "REVIEW"], int]
    hourly: list[DecisionSummaryHourly]


class DecisionLookupPackage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    packageName: str
    version: str
    integrity: str


class DecisionLookupRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requestId: UUID4
    packages: list[DecisionLookupPackage] = Field(min_length=1)


class DecisionLookupResult(BaseModel):
    packageName: str
    version: str
    integrity: str
    lookupStatus: Literal["FOUND", "NOT_FOUND"]
    decisionId: str | None = None
    decision: Literal["ACCEPT", "REJECT", "HOLD", "REVIEW"] | None = None
    policyKey: str | None = None
    policyVersion: str | None = None
    evaluatedAt: datetime | None = None

    @model_validator(mode="after")
    def validate_lookup_result(self) -> "DecisionLookupResult":
        if self.lookupStatus == "FOUND" and (
            not self.decisionId or self.decision is None
        ):
            raise ValueError(
                "FOUND results require decisionId and decision."
            )
        if self.lookupStatus == "NOT_FOUND" and any(
            value is not None
            for value in (
                self.decisionId,
                self.decision,
                self.policyKey,
                self.policyVersion,
                self.evaluatedAt,
            )
        ):
            raise ValueError("NOT_FOUND results cannot contain a Decision.")
        return self


class DecisionLookupResponse(BaseModel):
    requestId: UUID4
    results: list[DecisionLookupResult]


class FeedSnapshotCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ecosystem: Literal["npm"]
    packageName: str
    packageVersion: str
    source: Literal["OSV"]
    rawAdvisories: list[dict]
    validationResult: dict
    contentDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    collectedAt: datetime
    validatedAt: datetime

    @model_validator(mode="after")
    def validate_utc_timestamps(self) -> "FeedSnapshotCreate":
        for name in ("collectedAt", "validatedAt"):
            value = getattr(self, name)
            if value.utcoffset() is None:
                raise ValueError(f"{name} must include a UTC offset.")
        return self


class FeedLookupAttemptCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requestId: UUID
    scanId: UUID | None = None
    ecosystem: Literal["npm"]
    packageName: str
    packageVersion: str
    source: Literal["OSV"]
    feedStatus: Literal["SUCCESS", "FAILED", "TIMEOUT", "SKIPPED"]
    complete: bool
    errorCode: str | None = None
    skippedReason: str | None = None
    pagesFetched: int = Field(ge=0)
    startedAt: datetime
    completedAt: datetime
    failureDetail: str | None = None

    @model_validator(mode="after")
    def validate_status_fields(self) -> "FeedLookupAttemptCreate":
        if self.startedAt.utcoffset() is None or self.completedAt.utcoffset() is None:
            raise ValueError("Attempt timestamps must include a UTC offset.")
        if self.completedAt < self.startedAt:
            raise ValueError("completedAt must not precede startedAt.")
        if self.feedStatus != "SUCCESS" and self.complete:
            raise ValueError(f"{self.feedStatus} attempt cannot be complete.")
        if self.feedStatus == "SUCCESS" and (
            self.errorCode is not None or self.skippedReason is not None
        ):
            raise ValueError("SUCCESS attempt cannot contain failure fields.")
        if self.feedStatus == "SKIPPED" and not self.skippedReason:
            raise ValueError("SKIPPED attempt requires skippedReason.")
        if self.feedStatus in ("FAILED", "TIMEOUT") and not self.errorCode:
            raise ValueError(f"{self.feedStatus} attempt requires errorCode.")
        return self


class FeedPersistenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    attempt: FeedLookupAttemptCreate
    snapshot: FeedSnapshotCreate | None = None

    @model_validator(mode="after")
    def validate_snapshot_eligibility(self) -> "FeedPersistenceRequest":
        snapshot_eligible = (
            self.attempt.feedStatus == "SUCCESS" and self.attempt.complete
        )
        if snapshot_eligible != (self.snapshot is not None):
            raise ValueError(
                "Only complete SUCCESS attempts require a snapshot."
            )
        if self.snapshot and (
            self.snapshot.ecosystem != self.attempt.ecosystem
            or self.snapshot.packageName != self.attempt.packageName
            or self.snapshot.packageVersion != self.attempt.packageVersion
            or self.snapshot.source != self.attempt.source
        ):
            raise ValueError("Snapshot and attempt package identity must match.")
        return self


class FeedPersistenceResponse(BaseModel):
    attemptId: UUID
    snapshotId: UUID | None = None
    snapshotReused: bool
    contentChanged: bool = False
    previousSnapshotId: UUID | None = None
    reevaluationJobIds: list[UUID] = Field(default_factory=list)


class FeedSnapshotRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    ecosystem: Literal["npm"]
    packageName: str
    packageVersion: str
    source: Literal["OSV"]
    rawAdvisories: list[dict]
    validationResult: dict
    contentDigest: str = Field(pattern=r"^[0-9a-f]{64}$")
    collectedAt: datetime
    validatedAt: datetime
    expiresAt: datetime


class FeedRefreshCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal["OSV"]
    ecosystem: Literal["npm"]
    packageName: str
    packageVersion: str
    lastRequestedAt: datetime


class ReevaluationJobRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    ecosystem: Literal["npm"]
    packageName: str
    packageVersion: str
    artifactHash256: str | None = None
    artifactHash512: str | None = None
    scanId: UUID | None = None
    previousSnapshotId: UUID
    triggerSnapshotId: UUID
    previousDecisionId: str
    changeReason: Literal["CONTENT_DIGEST_CHANGED"]
    status: Literal["QUEUED", "RUNNING", "COMPLETED", "FAILED"]
    errorCode: str | None = None
    errorDetail: str | None = None
    createdAt: datetime
    startedAt: datetime | None = None
    completedAt: datetime | None = None


class ReevaluationJobClaimResponse(BaseModel):
    claimed: bool
    job: ReevaluationJobRecord


class ReevaluationJobFailure(BaseModel):
    errorCode: str = Field(min_length=1, max_length=100)
    errorDetail: str | None = None
