import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AnalysisContext, AnalyzerResult } from '../../domain/analysis.types';
import { CustomRuleAnalyzer } from '../custom-rule/custom-rule.analyzer';
import { GuardDogAnalyzer } from '../guarddog/guarddog.analyzer';
import { OpenAiGptCodeAssistant } from './gpt-code-assistant';
import { ObfuscationAnalyzer } from './obfuscation.analyzer';

function analyzerResult(
  analyzer: string,
  ruleId?: string,
  path?: string,
): AnalyzerResult {
  return {
    requestId: 'request-1',
    scanId: 'scan-1',
    analyzer,
    analyzerVersion: 'test',
    status: 'SUCCESS',
    findings: ruleId === undefined ? [] : [{
      findingId: `${analyzer}:${ruleId}:0`,
      ruleId,
      type: 'TEST',
      message: '테스트 Finding',
      ...(path === undefined ? {} : {
        location: { type: 'SOURCE_FILE' as const, path, startLine: 1 },
      }),
      data: {},
    }],
    errors: [],
  };
}

describe('ObfuscationAnalyzer', () => {
  let scanDir: string;
  let extractedPath: string;

  beforeEach(async () => {
    scanDir = await mkdtemp(join(tmpdir(), 'scanner-obfuscation-'));
    extractedPath = join(scanDir, 'extracted');
    await mkdir(join(extractedPath, 'package'), { recursive: true });
  });

  afterEach(async () => {
    await rm(scanDir, { recursive: true, force: true });
  });

  it('복원본만 재분석하고 GPT 모드를 off로 유지한다', async () => {
    const original = [
      "const encoded = Buffer.from('Y29uc29sZS5sb2coXCJyZXN0b3JlZFwiKTs=', 'base64').toString();",
      'eval(encoded);',
    ].join('\n');
    const sourcePath = join(extractedPath, 'package', 'setup.js');
    await writeFile(sourcePath, original, 'utf8');

    const customRuleAnalyzer = {
      version: 'test',
      analyzeResult: jest.fn().mockResolvedValue(
        analyzerResult('custom-rule', 'custom.process-execution', 'package/setup.js'),
      ),
    } as unknown as CustomRuleAnalyzer;
    const guardDogAnalyzer = {
      version: 'test',
      analyzeResult: jest.fn().mockResolvedValue(analyzerResult('guarddog')),
    } as unknown as GuardDogAnalyzer;
    const analyzer = new ObfuscationAnalyzer(
      customRuleAnalyzer,
      guardDogAnalyzer,
      'off',
    );

    const result = await analyzer.analyze(
      context(extractedPath),
      [analyzerResult('custom-rule')],
    );

    expect(result.summary).toMatchObject({
      gptMode: 'off',
      selectedFiles: 1,
      restoredFiles: 0,
      partialRestoredFiles: 1,
      unresolvedFiles: 0,
      newRuleIds: ['custom.process-execution'],
      gpt: { status: 'NOT_REQUESTED' },
    });
    expect(result.summary.evidenceBundles).toHaveLength(1);
    expect(result.summary.agentAnalysisRequest?.candidates).toHaveLength(1);
    expect(customRuleAnalyzer.analyzeResult).toHaveBeenCalledTimes(1);
    expect(guardDogAnalyzer.analyzeResult).toHaveBeenCalledTimes(1);
    expect(result.derivedAnalyzerResults.map(({ analyzer: name }) => name)).toEqual([
      'custom-rule-deobfuscated',
      'guarddog-deobfuscated',
    ]);
    expect(result.evidenceCandidates).toEqual([
      expect.objectContaining({
        analyzer: 'custom-rule-deobfuscated',
        path: 'package/setup.js',
        restoreStatus: 'PARTIAL_RESTORED',
      }),
    ]);
    expect(result.planningInput).toMatchObject({
      requestId: 'request-1',
      scanId: 'scan-1',
      artifactHash: 'a'.repeat(64),
      evidenceCandidates: [expect.objectContaining({
        analyzer: 'custom-rule-deobfuscated',
        restoreStatus: 'PARTIAL_RESTORED',
      })],
    });
    const detected = result.analyzerResult.findings.find(({ ruleId }) => ruleId === 'obfuscation.detected');
    expect(detected?.data).toMatchObject({
      supportingSignals: expect.arrayContaining(['BASE64_DECODE', 'DYNAMIC_EVAL']),
      candidateReasons: expect.arrayContaining([
        'DYNAMIC_EXECUTION_WITH_ENCODED_LITERAL',
        'EXECUTION_PATH_WITH_OBFUSCATION_SIGNAL',
      ]),
    });
    const restored = result.analyzerResult.findings.find(({ ruleId }) => ruleId === 'obfuscation.restored');
    expect(restored?.data).toMatchObject({
      status: 'PARTIAL_RESTORED',
      reason: 'DYNAMIC_DECODE_UNRESOLVED',
      limitations: expect.arrayContaining(['DYNAMIC_DECODE_UNRESOLVED']),
      stageResults: expect.arrayContaining([
        expect.objectContaining({ stage: 'STRING', status: 'COMPLETED', applied: true }),
      ]),
      validation: expect.objectContaining({
        original: expect.objectContaining({ parse: { valid: true } }),
        restored: expect.objectContaining({ parse: { valid: true } }),
      }),
    });
    expect(await readFile(sourcePath, 'utf8')).toBe(original);
    await expect(readFile(
      join(scanDir, 'derived', 'obfuscation', 'package', 'setup.js'),
      'utf8',
    )).resolves.toContain('console.log');
  });

  it('난독화 후보가 없으면 복원본 분석기를 실행하지 않는다', async () => {
    await writeFile(
      join(extractedPath, 'package', 'index.js'),
      'module.exports = 42;',
      'utf8',
    );
    const customRuleAnalyzer = {
      version: 'test',
      analyzeResult: jest.fn(),
    } as unknown as CustomRuleAnalyzer;
    const guardDogAnalyzer = {
      version: 'test',
      analyzeResult: jest.fn(),
    } as unknown as GuardDogAnalyzer;
    const analyzer = new ObfuscationAnalyzer(customRuleAnalyzer, guardDogAnalyzer);

    const result = await analyzer.analyze(context(extractedPath), []);

    expect(result.summary).toMatchObject({
      gptMode: 'off',
      selectedFiles: 0,
      restoredFiles: 0,
    });
    expect(customRuleAnalyzer.analyzeResult).not.toHaveBeenCalled();
    expect(guardDogAnalyzer.analyzeResult).not.toHaveBeenCalled();
    expect(result.analyzerResult.findings.some(({ ruleId }) => ruleId === 'obfuscation.detected')).toBe(false);
  });

  it('shadow 모드에서는 선별된 후보만 GPT 코드 이해 보조에 전달한다', async () => {
    await writeFile(
      join(extractedPath, 'package', 'setup.js'),
      [
        "const encoded = Buffer.from('ZmV0Y2goJ2h0dHBzOi8vZXhhbXBsZS5jb20nKQ==', 'base64').toString();",
        'eval(encoded);',
      ].join('\n'),
      'utf8',
    );
    const customRuleAnalyzer = {
      version: 'test',
      analyzeResult: jest.fn().mockResolvedValue(
        analyzerResult('custom-rule', 'custom.network-outbound', 'package/setup.js'),
      ),
    } as unknown as CustomRuleAnalyzer;
    const guardDogAnalyzer = {
      version: 'test',
      analyzeResult: jest.fn().mockResolvedValue(analyzerResult('guarddog')),
    } as unknown as GuardDogAnalyzer;
    const analyze = jest.fn().mockResolvedValue({
      status: 'COMPLETED',
      model: 'gpt-test',
      durationMs: 1,
      analysis: { files: [] },
    });
    const analyzer = new ObfuscationAnalyzer(
      customRuleAnalyzer,
      guardDogAnalyzer,
      'shadow',
      { analyze } as unknown as OpenAiGptCodeAssistant,
    );

    const result = await analyzer.analyze(context(extractedPath), []);

    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: '0.1',
        candidates: [expect.objectContaining({ path: 'package/setup.js' })],
      }),
      undefined,
    );
    expect(result.summary.gpt).toMatchObject({ status: 'COMPLETED', model: 'gpt-test' });
  });
});

function context(extractedPath: string): AnalysisContext {
  return {
    requestId: 'request-1',
    scanId: 'scan-1',
    package: { name: 'fixture', version: '1.0.0' },
    artifact: {
      tarballPath: join(extractedPath, '..', 'artifact.tgz'),
      extractedPath,
      hash: 'a'.repeat(64),
    },
    metadata: {
      registryMetadata: {},
      packageJson: {
        name: 'fixture',
        version: '1.0.0',
        scripts: { postinstall: 'node package/setup.js' },
      },
    },
  };
}
