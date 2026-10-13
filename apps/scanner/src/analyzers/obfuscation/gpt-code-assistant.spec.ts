import type { AgentAnalysisRequestV0_1 } from './agent-analysis.types';
import {
  OpenAiGptCodeAssistant,
  validateGptResponse,
} from './gpt-code-assistant';

describe('OpenAI GPT 코드 이해 보조', () => {
  it('Responses API를 호출하고 검증된 Shadow 결과만 반환한다', async () => {
    const transport = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify(validResponse()),
      usage: { input_tokens: 120, output_tokens: 30 },
    }), { status: 200 }));
    const assistant = new OpenAiGptCodeAssistant({
      apiKey: 'test-key',
      model: 'gpt-test',
      baseUrl: 'https://api.openai.test/v1/',
      timeoutMs: 1_000,
      maxOutputTokens: 256,
    }, transport);

    const outcome = await assistant.analyze(request());

    expect(outcome).toMatchObject({
      status: 'COMPLETED',
      provider: 'gpt',
      model: 'gpt-test',
      usage: { inputTokens: 120, outputTokens: 30 },
      promptVersion: 'tier2-code-understanding-v1',
    });
    expect(transport).toHaveBeenCalledWith(
      'https://api.openai.test/v1/responses',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = transport.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-test',
      store: false,
      input: [
        { role: 'system', content: expect.stringContaining('전체 코드를 재작성하거나') },
        { role: 'user' },
      ],
      text: { format: { type: 'json_schema', strict: true } },
    });
  });

  it('Scanner가 만들지 않은 Evidence ID를 인용한 응답은 거부한다', () => {
    const invalid = validResponse();
    invalid.files[0]!.behaviors[0]!.evidence_refs = ['invented-evidence'];

    expect(validateGptResponse(invalid, request())).toMatchObject({
      ok: false,
    });
  });

  it('후보 파일이 응답에서 빠지면 거부한다', () => {
    const input = request();
    input.candidates.push({ ...input.candidates[0]!, path: 'package/second.js' });
    expect(validateGptResponse(validResponse(), input).ok).toBe(false);
  });

  it('Slice에 없는 식별자 이름 제안은 거부한다', () => {
    const invalid = validResponse();
    invalid.files[0]!.renames[0]!.from = 'inventedName';
    expect(validateGptResponse(invalid, request()).ok).toBe(false);
  });

  it('설치 스크립트가 직접 실행하는 파일의 최상위 흐름은 LIFECYCLE로 기록한다', () => {
    const output = validResponse();
    output.files[0]!.data_flows.push({
      source: 'url', sink: 'fetch', reachable: 'TOP_LEVEL', explanation: '최상위 호출',
      evidence_refs: ['TIER_2:finding-1'],
    });
    const result = validateGptResponse(output, request());
    expect(result.analysis?.files[0]?.dataFlows[0]?.reachable).toBe('LIFECYCLE');
  });

  it('이름 제안의 Evidence ID를 결과에 보존한다', () => {
    const result = validateGptResponse(validResponse(), request());
    expect(result.analysis?.files[0]?.renameEvidenceRefs._0x1).toEqual(['TIER_2:finding-1']);
  });
});

  it('응답 path의 Windows separator를 canonical path로 검증한다', () => {
    const output = validResponse();
    output.files[0]!.path = 'package\\index.js';

    const result = validateGptResponse(output, request());

    expect(result).toMatchObject({ ok: true });
    expect(result.analysis?.files[0]?.path).toBe('package/index.js');
  });

function request(): AgentAnalysisRequestV0_1 {
  return {
    schemaVersion: '0.1',
    requestId: 'request-1',
    scanId: 'scan-1',
    sampleId: 'a'.repeat(64),
    purpose: 'DEOBFUSCATION_CODE_UNDERSTANDING',
    package: {
      ecosystem: 'npm',
      name: 'fixture',
      version: '1.0.0',
      artifactHash: 'a'.repeat(64),
      description: 'fixture package',
      lifecycleScripts: [{ name: 'postinstall', command: 'node package/index.js' }],
    },
    candidates: [{
      path: 'package/index.js',
      sourceKind: 'RESTORED',
      reason: 'RESTORED_WITH_NEW_SIGNAL',
      supportingReasons: ['RESTORED_WITH_NEW_SIGNAL'],
      restored: true,
      matchedSignals: ['custom.network-outbound'],
      residualCapabilities: ['NETWORK'],
      derivedNewRuleIds: ['custom.network-outbound'],
      restoration: {
        status: 'RESTORED',
        limitations: [],
        stageResults: [],
        appliedStages: ['STRUCTURE'],
      },
      evidences: [{
        evidenceId: 'TIER_2:finding-1',
        tier: 'TIER_2',
        analyzer: 'custom-rule-deobfuscated',
        ruleId: 'custom.network-outbound',
        message: 'network',
        path: 'package/index.js',
        line: 1,
      }],
      slices: [{
        file: 'package/index.js',
        startLine: 1,
        endLine: 1,
        code: 'const _0x1 = url; fetch(_0x1);',
      }],
    }],
  };
}

function validResponse() {
  return {
    files: [{
      path: 'package/index.js',
      behaviors: [{
        capability: 'NETWORK_EGRESS',
        explanation: 'fetch 호출이 있다.',
        evidence_refs: ['TIER_2:finding-1'],
      }],
      data_flows: [] as Array<{
        source: string;
        sink: string;
        reachable: string;
        explanation: string;
        evidence_refs: string[];
      }>,
      renames: [{
        from: '_0x1',
        to: 'requestUrl',
        evidence_refs: ['TIER_2:finding-1'],
      }],
      confidence: 0.8,
      limitations: [],
    }],
  };
}
