export const AGENT_OUTPUT_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://whsproject.local/agent-analysis-output.schema.json",
  "title": "ScannerAgentAnalysisOutputV0_1",
  "description": "Prototype technical analysis output. This is not a Policy decision contract.",
  "oneOf": [
    {
      "$ref": "#/$defs/additionalCodeResponse"
    },
    {
      "$ref": "#/$defs/completedResponse"
    }
  ],
  "$defs": {
    "additionalCodeResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "requestId",
        "schemaVersion",
        "status",
        "requests"
      ],
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1
        },
        "schemaVersion": {
          "const": "0.1.0"
        },
        "status": {
          "const": "NEEDS_ADDITIONAL_CODE"
        },
        "requests": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/codeRequest"
          }
        }
      }
    },
    "completedResponse": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "requestId",
        "schemaVersion",
        "status",
        "assessments",
        "summary",
        "limitations",
        "missingContext"
      ],
      "properties": {
        "requestId": {
          "type": "string",
          "minLength": 1
        },
        "schemaVersion": {
          "const": "0.1.0"
        },
        "status": {
          "const": "COMPLETED"
        },
        "assessments": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/assessment"
          }
        },
        "summary": {
          "$ref": "#/$defs/summary"
        },
        "limitations": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "missingContext": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "codeRequest": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "type",
        "target",
        "reasonCode",
        "maxLines"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "type": {
          "enum": [
            "GET_FILE_RANGE",
            "GET_PACKAGE_METADATA",
            "GET_SYMBOL_DEFINITION",
            "GET_SYMBOL_REFERENCES",
            "GET_CALLERS",
            "GET_IMPORT_RELATIONS"
          ]
        },
        "target": {
          "$ref": "#/$defs/codeRequestTarget"
        },
        "reasonCode": {
          "type": "string",
          "minLength": 1
        },
        "maxLines": {
          "type": "integer",
          "minimum": 1
        }
      }
    },
    "codeRequestTarget": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "file": {
          "type": "string",
          "minLength": 1
        },
        "symbol": {
          "type": "string",
          "minLength": 1
        },
        "lines": {
          "type": "array",
          "prefixItems": [
            {
              "type": "integer",
              "minimum": 1
            },
            {
              "type": "integer",
              "minimum": 1
            }
          ],
          "minItems": 2,
          "maxItems": 2
        }
      }
    },
    "assessment": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "type",
        "signal",
        "category",
        "basis",
        "refs",
        "flow",
        "reachability",
        "verification",
        "confidence",
        "reasonCodes"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "type": {
          "const": "CORRELATED_BEHAVIOR"
        },
        "signal": {
          "type": "string",
          "minLength": 1
        },
        "category": {
          "type": "string",
          "minLength": 1
        },
        "basis": {
          "enum": [
            "PATTERN_MATCH",
            "CO_OCCURRENCE",
            "EXECUTION_LINK",
            "DATA_FLOW",
            "TOOL_CORRELATION"
          ]
        },
        "findingIds": {
          "type": "array",
          "uniqueItems": true,
          "minItems": 1,
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "atomicEvidenceIds": {
          "type": "array",
          "uniqueItems": true,
          "minItems": 1,
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "refs": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/codeReference"
          }
        },
        "flow": {
          "$ref": "#/$defs/behaviorFlow"
        },
        "reachability": {
          "$ref": "#/$defs/reachability"
        },
        "verification": {
          "$ref": "#/$defs/verification"
        },
        "confidence": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "classification": {
          "enum": ["BENIGN_LIKELY", "DUAL_USE", "SUSPICIOUS", "LIKELY_MALICIOUS", "UNKNOWN"]
        },
        "intentAssessment": {
          "enum": ["BENIGN_LIKELY", "DUAL_USE", "SUSPICIOUS", "LIKELY_MALICIOUS", "UNKNOWN"]
        },
        "reasonCodes": {
          "type": "array",
          "uniqueItems": true,
          "minItems": 1,
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "rationale": {
          "type": "string",
          "minLength": 1
        },
        "alternatives": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/alternative"
          }
        },
        "limitations": {
          "type": "array",
          "uniqueItems": true,
          "minItems": 1,
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      }
    },
    "codeReference": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "id",
        "sliceId",
        "lines",
        "role"
      ],
      "properties": {
        "id": {
          "type": "string",
          "minLength": 1
        },
        "sliceId": {
          "type": "string",
          "minLength": 1
        },
        "lines": {
          "type": "array",
          "prefixItems": [
            {
              "type": "integer",
              "minimum": 1
            },
            {
              "type": "integer",
              "minimum": 1
            }
          ],
          "minItems": 2,
          "maxItems": 2
        },
        "role": {
          "enum": [
            "TRIGGER",
            "SOURCE",
            "TRANSFORM",
            "SINK",
            "CONDITION",
            "CONTEXT"
          ]
        }
      }
    },
    "behaviorFlow": {
      "type": "object",
      "description": "Behavior stages linked by codeReference id. Every value must be an id declared in the same assessment's refs, never a prose description. Omit an unconfirmed stage.",
      "additionalProperties": false,
      "properties": {
        "trigger": {
          "type": "string",
          "minLength": 1
        },
        "source": {
          "type": "string",
          "minLength": 1
        },
        "transforms": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "sink": {
          "type": "string",
          "minLength": 1
        },
        "conditions": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      }
    },
    "reachability": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "status"
      ],
      "properties": {
        "status": {
          "enum": [
            "CONFIRMED",
            "LIKELY",
            "POSSIBLE",
            "UNREACHABLE",
            "UNKNOWN"
          ]
        },
        "entry": {
          "type": "string",
          "minLength": 1
        },
        "path": {
          "type": "array",
          "minItems": 1,
          "items": {
            "type": "string",
            "minLength": 1
          }
        },
        "reasonCodes": {
          "type": "array",
          "uniqueItems": true,
          "minItems": 1,
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      }
    },
    "verification": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "status",
        "method"
      ],
      "properties": {
        "status": {
          "enum": [
            "VERIFIED",
            "PARTIALLY_VERIFIED",
            "UNVERIFIED",
            "REJECTED"
          ]
        },
        "method": {
          "enum": [
            "NONE",
            "SELF_VERIFIED",
            "DETERMINISTIC_VALIDATOR",
            "INDEPENDENT_VERIFIER"
          ]
        }
      }
    },
    "alternative": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "type",
        "plausibility",
        "reasonCodes"
      ],
      "properties": {
        "type": {
          "type": "string",
          "minLength": 1
        },
        "plausibility": {
          "enum": [
            "HIGH",
            "MEDIUM",
            "LOW",
            "UNKNOWN"
          ]
        },
        "reasonCodes": {
          "type": "array",
          "uniqueItems": true,
          "minItems": 1,
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      }
    },
    "summary": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "verdict",
        "confidence",
        "reasonCodes"
      ],
      "properties": {
        "verdict": {
          "enum": [
            "NO_MALICIOUS_BEHAVIOR_FOUND",
            "SUSPICIOUS",
            "LIKELY_MALICIOUS",
            "INCONCLUSIVE"
          ]
        },
        "confidence": {
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "reasonCodes": {
          "type": "array",
          "uniqueItems": true,
          "minItems": 1,
          "items": {
            "type": "string",
            "minLength": 1
          }
        }
      }
    }
  }
} as const;
