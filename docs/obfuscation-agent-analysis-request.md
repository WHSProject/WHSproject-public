# Obfuscation Agent 분석 요청 계약

## 목적

Tier 2가 복원한 코드 중 정적 분석만으로 의미를 확정하기 어려운 후보를 GPT 코드 이해 보조 또는 Tier 3에 전달한다. 이 결과는 Shadow 데이터이며 현재 Policy 판정에는 사용하지 않는다.

## 생성 조건

파일별 Tier 1·Tier 2 Finding을 결합한 뒤 다음 중 하나에 해당할 때만 요청 후보로 만든다.

- 수집·자격증명·환경변수 접근과 네트워크 등 강한 위험 조합이 같은 파일에 있음
- 복원 후 해당 파일에서 새로운 Rule ID가 검출됨
- 복원본에 동적 실행 신호가 남음
- 부분 복원 또는 미복원 상태이면서 프로세스·네트워크·수집 등 위험 신호가 있음

단순 Minify·Bundle, 위험 신호 없는 난독화, 정상 코드만 있는 파일은 제외한다.

## Schema 0.1

```json
{
  "schemaVersion": "0.1",
  "requestId": "request UUID",
  "scanId": "scan UUID",
  "sampleId": "artifact SHA-256",
  "purpose": "DEOBFUSCATION_CODE_UNDERSTANDING",
  "package": {
    "ecosystem": "npm",
    "name": "package-name",
    "version": "1.0.0",
    "artifactHash": "SHA-256",
    "description": "package description or null",
    "lifecycleScripts": [
      { "name": "postinstall", "command": "node package/setup.js" }
    ]
  },
  "candidates": [
    {
      "path": "package/setup.js",
      "reason": "RESTORED_WITH_NEW_SIGNAL",
      "restored": true,
      "matchedSignals": ["custom.network-outbound"],
      "restoration": {
        "status": "RESTORED",
        "appliedStages": ["STRUCTURE", "STRING"]
      },
      "evidences": [],
      "slices": []
    }
  ]
}
```

## LLM 동작

- 기본값은 `OBFUSCATION_GPT_MODE=off`이며 외부 호출이 없다.
- `shadow` 모드는 `OBFUSCATION_LLM_PROVIDER=gpt|gemini`로 한 제공자만 선택한다.
- GPT는 `OPENAI_API_KEY`, Gemini는 `GEMINI_API_KEY`가 있을 때만 시작된다.
- GPT는 Responses API, Gemini는 OpenAI 호환 Chat Completions API의 JSON Schema 출력을 사용한다.
- 패키지 코드는 신뢰하지 않는 데이터로 취급하고, 원문 전체 대신 후보별 최대 30,000자의 Slice만 전달한다.
- 함수 호출과 식별자는 보존하고 하드코딩된 토큰·비밀번호 형태의 값만 마스킹한다.
- LLM은 행동·데이터 흐름·도달 가능성·이름 제안만 반환하며 악성 여부를 판정하지 않는다.
- Scanner가 생성하지 않은 Evidence ID를 인용하거나 Schema가 맞지 않는 응답은 `REJECTED` 처리한다.
- 두 모델을 동시에 호출하거나 실패 시 다른 모델로 자동 전환하지 않는다. 비교 실험은 같은 요청을 별도로 실행한다.

구체적인 프롬프트 구성과 모델별 사용법은 [난독화 LLM 사용 및 프롬프트 설계](obfuscation-llm-prompting.md)에 정리한다.

## 저장과 Policy 경계

`agent-analysis-request`와 LLM 결과는 `ScanResult.shadowAnalyses`에 저장된다. 현재 `ScanHistoryService`가 메모리에 보관하므로 프로세스 재시작 후 유지되는 영속 저장은 아니다. Policy Client에는 기존 Tier 1 `evidences`만 전달한다.
