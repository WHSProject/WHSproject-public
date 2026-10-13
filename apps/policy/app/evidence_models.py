from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_serializer, model_validator


def reject_explicit_null(value: object, fields: tuple[str, ...]) -> object:
    if isinstance(value, dict) and any(field in value and value[field] is None for field in fields):
        raise ValueError("optional contract fields cannot be null")
    return value


class EvidenceSignal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    type: str
    category: str


class EvidenceSubject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ecosystem: Literal["npm"]
    packageName: str
    packageVersion: str
    artifactHash: str


class EvidenceAssertion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str
    basis: Literal[
        "PATTERN_MATCH",
        "METADATA_VALUE",
        "CO_OCCURRENCE",
        "EXECUTION_LINK",
        "DATA_FLOW",
        "TOOL_CORRELATION",
    ]


class EvidenceSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    analyzer: str
    analyzerVersion: str
    ruleId: str | None = None
    ruleVersion: str | None = None
    rawFindingId: str | None = None


class EvidenceLocationDerivedFrom(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1)
    startLine: int | None = Field(default=None, ge=1, strict=True)
    endLine: int | None = Field(default=None, ge=1, strict=True)

    @model_validator(mode="before")
    @classmethod
    def validate_optional_line_nulls(cls, value: object) -> object:
        return reject_explicit_null(value, ("startLine", "endLine"))

    @model_serializer
    def serialize(self) -> dict[str, str | int]:
        result: dict[str, str | int] = {"path": self.path}
        if self.startLine is not None:
            result["startLine"] = self.startLine
        if self.endLine is not None:
            result["endLine"] = self.endLine
        return result


class CapabilityObservationDerivedFrom(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    startLine: int | None = Field(default=None, ge=1, strict=True)
    endLine: int | None = Field(default=None, ge=1, strict=True)

    @model_validator(mode="before")
    @classmethod
    def validate_optional_line_nulls(cls, value: object) -> object:
        return reject_explicit_null(value, ("startLine", "endLine"))


class EvidenceLocation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["SOURCE_FILE", "METADATA"]
    path: str | None = None
    startLine: int | None = None
    startColumn: int | None = None
    endLine: int | None = None
    endColumn: int | None = None
    jsonPointer: str | None = None
    role: Literal[
        "OBSERVATION",
        "SOURCE",
        "SINK",
        "ENTRYPOINT",
        "TRIGGER",
        "TRANSFORM",
        "CONDITION",
        "CONTEXT",
    ] | None = None
    representation: Literal["ORIGINAL", "DEOBFUSCATED"] | None = None
    lineageStatus: Literal["DIRECT", "MAPPED", "UNMAPPED"] | None = None
    derivedFrom: EvidenceLocationDerivedFrom | None = None

    @model_validator(mode="before")
    @classmethod
    def validate_extension_nulls(cls, value: object) -> object:
        return reject_explicit_null(value, ("representation", "lineageStatus", "derivedFrom"))


class EvidenceDerivedFrom(BaseModel):
    model_config = ConfigDict(extra="forbid")

    findingIds: list[str] = Field(default_factory=list)
    evidenceIds: list[str] = Field(default_factory=list)


class EvidenceProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scanId: str
    generatedBy: Literal["EVIDENCE_NORMALIZER", "EVIDENCE_CORRELATOR"] | None = None
    observedAt: datetime | None = None
    producerType: Literal["LLM_AGENT"] | None = None
    analysisId: str | None = None
    assessmentId: str | None = None
    agentType: str | None = None
    agentVersion: str | None = None
    model: str | None = None
    promptVersion: str | None = None
    inputSchemaVersion: str | None = None
    outputSchemaVersion: str | None = None


class CapabilityObservation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    analyzer: str
    analyzerVersion: str
    ruleId: str
    findingId: str
    path: str
    startLine: int | None = Field(default=None, ge=1, strict=True)
    endLine: int | None = Field(default=None, ge=1, strict=True)
    representation: Literal["ORIGINAL", "DEOBFUSCATED"]
    lineageStatus: Literal["DIRECT", "MAPPED", "UNMAPPED"]
    derivedFrom: CapabilityObservationDerivedFrom | None = None

    @model_validator(mode="before")
    @classmethod
    def validate_optional_fields(cls, value: object) -> object:
        return reject_explicit_null(value, ("startLine", "endLine", "derivedFrom"))


class CapabilityComparison(BaseModel):
    model_config = ConfigDict(extra="forbid")

    capability: str
    status: Literal["PRESERVED", "LOST", "DISCOVERED", "NOT_VERIFIED", "NOT_APPLICABLE"]
    original: list[CapabilityObservation]
    deobfuscated: list[CapabilityObservation]


class CapabilityValidation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    before: list[str]
    after: list[str] | None
    status: Literal["PRESERVED", "LOST", "DISCOVERED", "NOT_VERIFIED", "NOT_APPLICABLE"]
    preserved: list[str]
    lost: list[str]
    discovered: list[str]
    comparisons: list[CapabilityComparison]
    limitations: list[str]
    originalPath: str | None = None
    deobfuscatedPaths: list[str] | None = None
    restoreStatus: Literal["RESTORED", "PARTIAL_RESTORED", "UNRESOLVED", "SKIPPED", "FAILED"] | None = None

    @model_validator(mode="before")
    @classmethod
    def validate_optional_fields(cls, value: object) -> object:
        return reject_explicit_null(value, ("originalPath", "deobfuscatedPaths", "restoreStatus"))

    @model_serializer
    def serialize(self) -> dict:
        result = {
            "before": self.before,
            "after": self.after,
            "status": self.status,
            "preserved": self.preserved,
            "lost": self.lost,
            "discovered": self.discovered,
            "comparisons": [item.model_dump(mode="json", exclude_none=True) for item in self.comparisons],
            "limitations": self.limitations,
        }
        if self.originalPath is not None:
            result["originalPath"] = self.originalPath
        if self.deobfuscatedPaths is not None:
            result["deobfuscatedPaths"] = self.deobfuscatedPaths
        if self.restoreStatus is not None:
            result["restoreStatus"] = self.restoreStatus
        return result


class CapabilityPreservationFile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    originalPath: str
    deobfuscatedPaths: list[str] = Field(default_factory=list)
    restoreStatus: Literal["RESTORED", "PARTIAL_RESTORED", "UNRESOLVED", "SKIPPED", "FAILED"]
    validation: CapabilityValidation


class CapabilityPreservationReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["PRESERVED", "LOST", "DISCOVERED", "NOT_VERIFIED", "NOT_APPLICABLE"]
    files: list[CapabilityPreservationFile] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)


class EvidenceV01(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["0.1"]
    evidenceId: str
    kind: Literal["ATOMIC", "CORRELATED", "LLM_ASSESSMENT"]
    analysisPass: Literal["TIER1", "TIER2"] | None = None
    taxonomy: Literal[
        "INSTALLATION_AND_EXECUTION",
        "DISCOVERY_AND_COLLECTION",
        "CREDENTIAL_AND_SENSITIVE_DATA_ACCESS",
        "NETWORK_C2_AND_EXFILTRATION",
        "PAYLOAD_AND_DYNAMIC_CODE",
        "FILESYSTEM_AND_SYSTEM_MODIFICATION",
        "PERSISTENCE_AND_PROPAGATION",
        "EVASION_AND_OBFUSCATION",
        "PACKAGE_AND_PUBLISHING_RISK",
    ] | None = None
    action: str | None = Field(default=None, min_length=1)
    signal: EvidenceSignal
    subject: EvidenceSubject
    assertion: EvidenceAssertion
    sources: list[EvidenceSource] = Field(min_length=1)
    locations: list[EvidenceLocation] = Field(default_factory=list)
    derivedFrom: EvidenceDerivedFrom | None = None
    provenance: EvidenceProvenance
    limitations: list[str] = Field(default_factory=list)
    capabilityPreservation: CapabilityValidation | None = None
    executionContext: dict[str, object] | None = None
    reachability: dict[str, object] | None = None
    intentAssessment: Literal[
        "BENIGN_LIKELY",
        "DUAL_USE",
        "SUSPICIOUS",
        "LIKELY_MALICIOUS",
        "UNKNOWN",
    ] | None = None
    verificationStatus: Literal[
        "VERIFIED",
        "PARTIALLY_VERIFIED",
        "UNVERIFIED",
        "REJECTED",
    ] | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    reasonCodes: list[str] = Field(default_factory=list)
    alternatives: list[dict[str, object]] = Field(default_factory=list)
    relatedFindingIds: list[str] = Field(default_factory=list)
    relatedAtomicEvidenceIds: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def validate_extension_nulls(cls, value: object) -> object:
        return reject_explicit_null(value, ("analysisPass", "taxonomy", "action", "capabilityPreservation"))
