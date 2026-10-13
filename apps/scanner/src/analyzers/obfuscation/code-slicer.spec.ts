import { redactSensitiveValues, sliceCode } from './code-slicer';

describe('GPT 코드 Slice', () => {
  it('위험 위치 주변만 추출하고 식별자·호출 구조는 유지한다', () => {
    const code = Array.from({ length: 100 }, (_, index) =>
      index === 49 ? 'send(process.env.TOKEN);' : `const line${index} = ${index};`).join('\n');

    const slices = sliceCode('package/index.js', code, [{
      evidenceId: 'TIER_2:finding-1',
      tier: 'TIER_2',
      analyzer: 'custom-rule-deobfuscated',
      ruleId: 'custom.network-outbound',
      message: 'network',
      path: 'package/index.js',
      line: 50,
    }]);

    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ startLine: 30, endLine: 70 });
    expect(slices[0]?.code).toContain('send(process.env.TOKEN)');
  });

  it('하드코딩된 민감값만 가린다', () => {
    expect(redactSensitiveValues("const apiKey = 'secret-value-123'; fetch(url);"))
      .toBe("const apiKey = '<redacted>'; fetch(url);");
  });
});
