import { detect } from './detector';

describe('detect', () => {
  it.each([
    ['CHAR_CODE only', 'const value = String.fromCharCode(72, 105, 33);', 'CHAR_CODE'],
    ['ESCAPED_LITERAL only', "const value = '\\u0068\\u0069';", 'ESCAPED_LITERAL'],
    ['normal Base64 config decode', "const config = JSON.parse(Buffer.from('eyJkZWJ1ZyI6ZmFsc2V9', 'base64').toString('utf8'));", 'BASE64_DECODE'],
    ['normal Unicode escape', "const value = '\\uc548\\ub155\\ud558\\uc138\\uc694';", 'ESCAPED_LITERAL'],
  ] as const)('%s is not a candidate without supporting context', (_name, source, signal) => {
    const verdict = detect('package/index.js', source);

    expect(verdict.obfuscated).toBe(false);
    expect(verdict.candidateReasons).toEqual([]);
    expect(verdict.supportingSignals).toContain(signal);
  });

  it('does not promote minified code or a normal parser dispatch loop', () => {
    const minified = detect(
      'package/min.js',
      '!function(e){return e.map(function(n){return n+1})}([1,2,3]);'.repeat(4),
    );
    const parser = detect(
      'package/parser.js',
      "const handlers = { 'next': function (value) { return value + 1; } };"
        + 'let opcode=0; while (true) { switch (opcode) { case 0: opcode=handlers.next(opcode); break; default: opcode=2; } }',
    );
    const bundle = detect(
      'package/bundle.js',
      '(function(modules){function __webpack_require__(id){var module={exports:{}};'
        + 'modules[id](module,module.exports,__webpack_require__);return module.exports;}'
        + 'return __webpack_require__(0);}({0:function(module,exports){module.exports={value:1};}}));',
    );

    expect(minified.obfuscated).toBe(false);
    expect(parser.obfuscated).toBe(false);
    expect(parser.supportingSignals).not.toContain('CONTROL_FLOW_FLATTENING');
    expect(bundle.obfuscated).toBe(false);
  });

  it('keeps an actual flattened dispatch loop as a structural candidate', () => {
    const source = [
      'const order = [1, 0, 2];',
      'let state = 0;',
      "const helpers = { 'advance': function (value) { return value + 1; } };",
      'while (true) {',
      '  switch (order[state]) {',
      '    case 1: state = helpers.advance(state); break;',
      '    case 0: state = 1; break;',
      '    default: state = 2; break;',
      '  }',
      '  if (state === 2) break;',
      '}',
      'const marker = String.fromCharCode(99, 111, 110, 115, 111, 108, 101);',
    ].join('\n');
    const verdict = detect('package/flattened.js', source);

    expect(verdict.obfuscated).toBe(true);
    expect(verdict.supportingSignals).toEqual(expect.arrayContaining([
      'CONTROL_FLOW_FLATTENING',
      'CHAR_CODE',
    ]));
    expect(verdict.candidateReasons).toContain('STRONG_CONTROL_FLOW_OBFUSCATION');
  });

  it('flags dense helper indirection (>= 3) as a control-flow candidate without other signals', () => {
    // javascript-obfuscator 의 제어흐름 평탄화는 while/switch 패턴 없이도 다수의
    // 계산된 helper 함수로 연산을 우회한다. helper 가 임계치 이상이면 그 자체로 후보다.
    // 근거: JsDeObsBench 제어흐름군 재현율 29%→61%, 대조군 오탐 0, 실전 npm 신규 오탐 2파일.
    const helpers = ["'aa'", "'bb'", "'cc'"]
      .map((key) => `${key}: function (a, b) { return a + b; }`)
      .join(', ');
    const source = `const helpers = { ${helpers} };\n`
      + 'let value = 0;\n'
      + 'value = helpers.aa(value, 1);\n'
      + 'value = helpers.bb(value, 2);\n'
      + 'value = helpers.cc(value, 3);\n'
      // Keep padding syntactically valid for structural parsing (no duplicate const).
      + 'void 1;\n'.repeat(10);
    const verdict = detect('package/flattened-dense.js', source);

    expect(verdict.features.controlFlowIndirectionCount).toBeGreaterThanOrEqual(3);
    expect(verdict.obfuscated).toBe(true);
    expect(verdict.supportingSignals).toContain('CONTROL_FLOW_FLATTENING');
    expect(verdict.candidateReasons).toContain('STRONG_CONTROL_FLOW_OBFUSCATION');
  });

  it('does not flag one or two quoted-key helper methods as control-flow obfuscation', () => {
    // 정상 파서·디스패치·유틸(예: 소수의 quoted-key 메서드)은 후보로 올리지 않는다.
    const source = "const dispatch = { 'next': function (v) { return v + 1; }, "
      + "'prev': function (v) { return v - 1; } };\nmodule.exports = dispatch;";
    const verdict = detect('package/dispatch.js', source);

    expect(verdict.features.controlFlowIndirectionCount).toBe(2);
    expect(verdict.obfuscated).toBe(false);
    expect(verdict.supportingSignals).not.toContain('CONTROL_FLOW_FLATTENING');
  });

  it('selects encoded literals combined with dynamic execution', () => {
    const verdict = detect(
      'package/setup.js',
      'eval(String.fromCharCode(99, 111, 110, 115, 111, 108, 101));',
    );

    expect(verdict.obfuscated).toBe(true);
    expect(verdict.candidateReasons).toContain('DYNAMIC_EXECUTION_WITH_ENCODED_LITERAL');
    expect(verdict.supportingSignals).toEqual(expect.arrayContaining(['CHAR_CODE', 'DYNAMIC_EVAL']));
  });

  it('keeps strong structural positives as candidates', () => {
    const source = 'var _0xaaaaaa = 1; var _0xbbbbbb = 2;\n'
      + 'const value = 1;\n'.repeat(20);
    const verdict = detect('package/index.js', source);

    expect(verdict.obfuscated).toBe(true);
    expect(verdict.structuralCandidate).toBe(true);
    expect(verdict.candidateReasons).toContain('STRONG_CONTROL_FLOW_OBFUSCATION');
  });

  it('uses risk capability and execution path as supporting context, not standalone reasons', () => {
    const weak = "const value = '\\u0068\\u0069';";
    const riskVerdict = detect('package/worker.js', weak, {
      riskCapabilityRuleIds: ['capability-process-spawn'],
    });
    const entryVerdict = detect('package/index.js', weak, { executionPath: true });
    const entryOnlyVerdict = detect('package/index.js', 'module.exports = 1;', { executionPath: true });

    expect(riskVerdict.candidateReasons).toContain('RISK_CAPABILITY_WITH_OBFUSCATION_SIGNAL');
    expect(riskVerdict.riskCapabilityRuleIds).toEqual(['capability-process-spawn']);
    expect(entryVerdict.candidateReasons).toContain('EXECUTION_PATH_WITH_OBFUSCATION_SIGNAL');
    expect(entryOnlyVerdict.obfuscated).toBe(false);
  });
});
