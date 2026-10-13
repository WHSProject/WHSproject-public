import type { AnalyzerResult, Finding } from '../../domain/analysis.types';
import {
  calculateMappingHash,
  DEFAULT_EVIDENCE_MAPPING_RULES,
  EVIDENCE_MAPPING_VERSION,
  EvidenceMappingRegistry,
} from './evidence-mapping.registry';
import { EvidenceNormalizer } from './evidence-normalizer';
import type {
  EvidenceMappingRule,
  NormalizationInput,
  Tier2EvidenceCandidateInput,
} from './evidence-normalizer.types';

describe('EvidenceMappingRegistry', () => {
  const registry = new EvidenceMappingRegistry();

  it.each([
    ['metadata.lifecycle.preinstall', 'capability.lifecycle.preinstall', 'PREINSTALL_SCRIPT'],
    ['metadata.lifecycle.install', 'capability.lifecycle.install', 'INSTALL_SCRIPT'],
    ['metadata.lifecycle.postinstall', 'capability.lifecycle.postinstall', 'POSTINSTALL_SCRIPT'],
    ['metadata.lifecycle.prepare', 'capability.lifecycle.prepare', 'LIFECYCLE_SCRIPT'],
    ['metadata.license.mismatch', 'consistency.metadata.license-mismatch', 'METADATA_MISMATCH'],
    ['metadata.repository.mismatch', 'consistency.metadata.repository-mismatch', 'METADATA_MISMATCH'],
  ] as const)('uses the actual Metadata Rule ID %s', (ruleId, signalId, signalType) => {
    const mapping = registry.find('metadata', ruleId);

    expect(mapping).toMatchObject({
      analyzerName: 'metadata',
      ruleId,
      mappingStatus: 'EXACT',
      targets: [expect.objectContaining({ signalId, signalType })],
    });
  });

  it.each([
    ['custom.sensitive-file-access', ['capability.filesystem.sensitive-read'], ['SENSITIVE_FILE_READ']],
    ['custom.lifecycle-process-coexistence', ['capability.process.spawn'], ['CHILD_PROCESS']],
    ['custom.env-network-coexistence', ['capability.environment.read', 'capability.network.outbound'], ['ENV_READ', 'NETWORK_EGRESS']],
    [
      'custom.sensitive-file-network-coexistence',
      ['capability.filesystem.sensitive-read', 'capability.network.outbound'], ['SENSITIVE_FILE_READ', 'NETWORK_EGRESS'],
    ],
  ] as const)('uses the actual Custom Rule ID %s', (ruleId, signalIds, signalTypes) => {
    const mapping = registry.find('custom-rule', ruleId);

    expect(mapping).toMatchObject({
      analyzerName: 'custom-rule',
      ruleId,
      mappingStatus: 'PARTIAL',
    });
    expect(mapping?.targets.map(({ signalId }) => signalId)).toEqual(
      signalIds,
    );
    expect(mapping?.targets.map(({ signalType }) => signalType)).toEqual(signalTypes);
  });

  it('maps the form-data exfiltration rule to the existing network capability', () => {
    expect(registry.find('custom-rule', 'threat-network-form-data-exfiltration')).toMatchObject({
      analyzerName: 'custom-rule',
      ruleId: 'threat-network-form-data-exfiltration',
      mappingStatus: 'EXACT',
      targets: [expect.objectContaining({
        signalId: 'capability.network.outbound',
        signalType: 'NETWORK_EGRESS',
        assertionBasis: 'DATA_FLOW',
      })],
    });
  });

  it.each([
    ['custom.lifecycle-entry', 'INSTALLATION_AND_EXECUTION', 'LIFECYCLE_ENTRY', 'METADATA'],
    ['custom.process-execution', 'INSTALLATION_AND_EXECUTION', 'PROCESS_EXECUTION', 'EXECUTION'],
    ['custom.collection-source', 'DISCOVERY_AND_COLLECTION', 'INFORMATION_COLLECTION', 'SYSTEM'],
    ['custom.credential-source', 'CREDENTIAL_AND_SENSITIVE_DATA_ACCESS', 'CREDENTIAL_ACCESS', 'ENVIRONMENT'],
    ['custom.network-outbound', 'NETWORK_C2_AND_EXFILTRATION', 'NETWORK_REQUEST', 'NETWORK'],
    ['custom.remote-download', 'PAYLOAD_AND_DYNAMIC_CODE', 'REMOTE_PAYLOAD_DOWNLOAD', 'NETWORK'],
    ['custom.filesystem.write', 'FILESYSTEM_AND_SYSTEM_MODIFICATION', 'FILE_WRITE', 'FILESYSTEM'],
  ] as const)('maps P0 Rule %s through taxonomy/action Mapping Target', (
    ruleId,
    taxonomy,
    action,
    signalCategory,
  ) => {
    expect(registry.find('custom-rule', ruleId)).toMatchObject({
      mappingStatus: 'PARTIAL',
      targets: [expect.objectContaining({ taxonomy, action, signalCategory })],
    });
  });

  it.each([
    ['capability-process-spawn', 'EXACT', 'CHILD_PROCESS', 'capability.process.spawn'],
    ['capability-network-outbound', 'EXACT', 'NETWORK_EGRESS', 'capability.network.outbound'],
    ['capability-network-download', 'EXACT', 'REMOTE_FETCH', 'capability.network.download'],
    ['threat-runtime-environment-read', 'EXACT', 'ENV_READ', 'threat.runtime.environment.read'],
    ['threat-process-sysinfo', 'PARTIAL', 'SYSTEM_INFO', 'threat.process.sysinfo'],
    ['threat-runtime-obfuscation-base64exec', 'EXACT', 'OBFUSCATED_CODE', 'threat.runtime.obfuscation.base64exec'],
    ['threat-network-exfiltration', 'PARTIAL', 'NETWORK_EGRESS', 'threat.network.suspicious-endpoint'],
  ] as const)(
    'registers the GuardDog Rule %s as %s',
    (ruleId, mappingStatus, signalType, signalId) => {
      const mapping = registry.find('guarddog', ruleId);
      expect(mapping).toMatchObject({
        analyzerName: 'guarddog',
        ruleId,
        mappingStatus,
      });
      expect(mapping?.targets).toEqual(expect.arrayContaining([
        expect.objectContaining({ signalType, signalId }),
      ]));
    },
  );

  it.each([
    'capability-filesystem-delete',
    'capability-filesystem-browser',
    'capability-filesystem-read',
    'capability-filesystem-write-executable',
    'capability-network-download',
    'capability-network-outbound',
    'capability-process-hooks',
    'capability-process-spawn',
    'threat-filesystem-autostart',
    'threat-filesystem-destruction',
    'threat-filesystem-read',
    'threat-npm-http-dependency',
    'threat-npm-dependency-confusion',
    'threat-npm-preinstall-script',
    'threat-runtime-environment-read',
    'threat-runtime-keylogging',
    'threat-runtime-obfuscation',
    'threat-runtime-obfuscation-api',
    'threat-runtime-obfuscation-base64exec',
    'threat-runtime-obfuscation-chr',
    'threat-runtime-obfuscation-dynamic-eval',
    'threat-runtime-obfuscation-general',
    'threat-runtime-obfuscation-hidden-code',
    'threat-runtime-obfuscation-import-exec',
    'threat-runtime-obfuscation-js-mangling',
    'threat-runtime-obfuscation-pyarmor',
    'threat-runtime-obfuscation-steganography',
    'threat-runtime-obfuscation-unicode',
    'threat-runtime-system-info',
  ])('classifies GuardDog Rule %s as EXACT', (ruleId) => {
    expect(registry.find('guarddog', ruleId)?.mappingStatus).toBe('EXACT');
  });

  it.each([
    'threat-network-exfil-messenger',
    'threat-network-dns-exfil',
    'threat-network-exfil-sysinfo',
    'threat-network-exfiltration',
    'threat-network-outbound-shady-links',
    'threat-network-reverse-shell',
    'capability-network-lolbas',
    'threat-process-download-exec',
    'threat-process-hooks',
    'threat-process-powershell-encoded',
    'threat-process-sysinfo',
    'threat-process-spawn-silent',
    'threat-runtime-dynamic-loader',
    'threat-runtime-enumeration',
    'threat-runtime-obfuscation-log-suppress',
    'threat-setup-import-aliasing',
    'threat-setup-network-in-install',
  ])('classifies GuardDog Rule %s as PARTIAL', (ruleId) => {
    expect(registry.find('guarddog', ruleId)?.mappingStatus).toBe('PARTIAL');
  });

  it.each([
    'capability-process-schedule',
    'capability-runtime-clipboard',
    'threat-process-cryptomining',
    'threat-process-injection-dll',
    'threat-process-memory',
    'threat-runtime-screencapture',
    'threat-runtime-self-propagation',
    'threat-setup-suspicious-imports',
  ])('leaves insufficiently verified GuardDog Rule %s UNMAPPED', (ruleId) => {
    expect(registry.find('guarddog', ruleId)).toBeUndefined();
  });

  it('does not match the same Rule ID from a different Analyzer', () => {
    expect(
      registry.find('another-analyzer', 'metadata.lifecycle.postinstall'),
    ).toBeUndefined();
  });

  it('produces the same Mapping Hash regardless of declaration order', () => {
    expect(
      calculateMappingHash([...DEFAULT_EVIDENCE_MAPPING_RULES].reverse()),
    ).toBe(calculateMappingHash(DEFAULT_EVIDENCE_MAPPING_RULES));
  });

  it('produces the same Mapping Hash regardless of target order', () => {
    const reordered = DEFAULT_EVIDENCE_MAPPING_RULES.map((rule) => {
      if (
        (rule.mappingStatus === 'EXACT' || rule.mappingStatus === 'PARTIAL') &&
        rule.ruleId === 'custom.env-network-coexistence'
      ) {
        const reversedTargets = [...rule.targets].reverse() as [
          (typeof rule.targets)[number],
          ...(typeof rule.targets)[number][],
        ];
        return {
          ...rule,
          targets: reversedTargets,
        };
      }
      return rule;
    });

    expect(calculateMappingHash(reordered)).toBe(
      calculateMappingHash(DEFAULT_EVIDENCE_MAPPING_RULES),
    );
  });

  it('changes the Mapping Hash when meaningful Mapping content changes', () => {
    const changed = DEFAULT_EVIDENCE_MAPPING_RULES.map((rule, index) => {
      if (
        index !== 0 ||
        (rule.mappingStatus !== 'EXACT' && rule.mappingStatus !== 'PARTIAL')
      ) {
        return rule;
      }
      const [firstTarget, ...remainingTargets] = rule.targets;
      return {
        ...rule,
        targets: [
          {
            ...firstTarget,
            limitations: [...firstTarget.limitations, 'changed'],
          },
          ...remainingTargets,
        ],
      } as EvidenceMappingRule;
    });

    expect(calculateMappingHash(changed)).not.toBe(
      calculateMappingHash(DEFAULT_EVIDENCE_MAPPING_RULES),
    );
  });

  it.each([
    ['taxonomy', { taxonomy: 'EVASION_AND_OBFUSCATION' as const }],
    ['action', { action: 'CHANGED_ACTION' }],
  ])('changes the Mapping Hash when GuardDog Mapping %s changes', (_field, targetChange) => {
    const changed = DEFAULT_EVIDENCE_MAPPING_RULES.map((rule) => {
      if (
        rule.ruleId !== 'threat-runtime-system-info' ||
        (rule.mappingStatus !== 'EXACT' && rule.mappingStatus !== 'PARTIAL')
      ) {
        return rule;
      }
      const [firstTarget, ...remainingTargets] = rule.targets;
      return {
        ...rule,
        targets: [{ ...firstTarget, ...targetChange }, ...remainingTargets],
      } as EvidenceMappingRule;
    });

    expect(calculateMappingHash(changed)).not.toBe(
      calculateMappingHash(DEFAULT_EVIDENCE_MAPPING_RULES),
    );
  });
});

describe('EvidenceNormalizer', () => {
  it('returns an empty successful normalization result for zero Findings', () => {
    const result = deterministicNormalizer().normalize(
      input([analyzerResult('metadata'), analyzerResult('custom-rule')]),
    );

    expect(result.atomicEvidences).toEqual([]);
    expect(result.unmappedFindings).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      inputFindingCount: 0,
      normalizedFindingCount: 0,
      atomicEvidenceCount: 0,
      unmappedFindingCount: 0,
      invalidFindingCount: 0,
      deduplicatedEvidenceCount: 0,
    });
  });

  it('normalizes only validated Tier2 candidates and keeps them separate from Tier1 Evidence', () => {
    const tier1Finding = finding(
      'custom.process-execution',
      { code: 'exec(original)' },
      { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 1 },
    );
    const tier2Candidate = tier2CandidateValue(
      'custom-rule-deobfuscated',
      'custom.process-execution',
      'tier2-process',
      'RESTORED',
    );

    const result = deterministicNormalizer().normalize(
      input([analyzerResult('custom-rule', tier1Finding)], [tier2Candidate]),
    );

    expect(result.atomicEvidences).toHaveLength(2);
    expect(result.atomicEvidences.map(({ analysisPass }) => analysisPass)).toEqual([
      undefined,
      'TIER2',
    ]);
    expect(result.atomicEvidences[1]).toMatchObject({
      sources: [{ analyzer: 'custom-rule-deobfuscated', rawFindingId: 'tier2-process' }],
    });
    expect(result.atomicEvidences[1]?.locations).toHaveLength(2);
    expect(result.atomicEvidences[1]?.locations[0]).toMatchObject({
      path: 'package/decoded.js',
      startLine: 12,
      representation: 'DEOBFUSCATED',
      lineageStatus: 'UNMAPPED',
      derivedFrom: { path: 'package/index.js' },
    });
    expect(result.atomicEvidences[0]?.sources).toEqual([
      expect.objectContaining({ analyzer: 'custom-rule', rawFindingId: 'finding-1' }),
    ]);
    expect(new Set(result.atomicEvidences.map(({ evidenceId }) => evidenceId)).size).toBe(2);
  });

  it('preserves GuardDog mapping, multiple derived locations, and partial restore limitations', () => {
    const result = deterministicNormalizer().normalize(
      input([], [tier2CandidateValue(
        'guarddog-deobfuscated',
        'capability-network-outbound',
        'tier2-network',
        'PARTIAL_RESTORED',
      )]),
    );

    expect(result.atomicEvidences).toHaveLength(1);
    expect(result.atomicEvidences[0]).toMatchObject({
      analysisPass: 'TIER2',
      signal: { id: 'capability.network.outbound', type: 'NETWORK_EGRESS' },
      sources: [{ analyzer: 'guarddog-deobfuscated', ruleId: 'capability-network-outbound' }],
      locations: [
        { path: 'package/decoded.js', startLine: 12, derivedFrom: { path: 'package/index.js' } },
        { path: 'package/decoded-payload.js', startLine: 14, derivedFrom: { path: 'package/index.js' } },
      ],
      limitations: expect.arrayContaining(['STRING_STAGE_FAILED', 'PARTIAL_RESTORED']),
    });
  });

  it('carries capability preservation status and provenance into Tier2 Evidence', () => {
    const candidate = tier2CandidateValue(
      'guarddog-deobfuscated',
      'capability-network-outbound',
      'tier2-network-capability',
      'RESTORED',
    );
    candidate.capabilityPreservation = {
      before: ['capability.network.outbound'],
      after: ['capability.network.outbound', 'capability.process.spawn'],
      status: 'PRESERVED',
      preserved: ['capability.network.outbound'],
      lost: [],
      discovered: ['capability.process.spawn'],
      comparisons: [{
        capability: 'capability.network.outbound',
        status: 'PRESERVED',
        original: [{ analyzer: 'guarddog', analyzerVersion: '1', ruleId: 'capability-network-outbound', findingId: 'tier1-network', path: 'package/index.js', representation: 'ORIGINAL', lineageStatus: 'DIRECT' }],
        deobfuscated: [{ analyzer: 'guarddog-deobfuscated', analyzerVersion: '1', ruleId: 'capability-network-outbound', findingId: 'tier2-network', path: 'package/decoded.js', representation: 'DEOBFUSCATED', lineageStatus: 'MAPPED', derivedFrom: { path: 'package/index.js', startLine: 5, endLine: 5 } }],
      }],
      limitations: [],
      originalPath: 'package/index.js',
      deobfuscatedPaths: ['package/decoded.js'],
      restoreStatus: 'RESTORED',
    };

    const result = deterministicNormalizer().normalize(input([], [candidate]));

    expect(result.atomicEvidences[0]?.capabilityPreservation).toMatchObject({
      status: 'PRESERVED',
      discovered: ['capability.process.spawn'],
      comparisons: [{ capability: 'capability.network.outbound', status: 'PRESERVED' }],
    });
  });

  it('adds mapped original coordinates to normalized Tier2 Evidence provenance', () => {
    const candidate = tier2CandidateValue(
      'custom-rule-deobfuscated',
      'custom.process-execution',
      'tier2-mapped',
      'RESTORED',
    );
    candidate.lineMapping = {
      version: '0.1.0',
      sourcePath: 'package/index.js',
      derivedPath: 'package/decoded.js',
      status: 'MAPPED',
      entries: [
        { derivedLine: 12, sourceLine: 5, confidence: 'EXACT' },
        { derivedLine: 14, sourceLine: 7, confidence: 'APPROXIMATE' },
      ],
      derivedLineCount: 14,
      mappedLineCount: 2,
      limitations: [],
    };
    candidate.lineMappings = [
      candidate.lineMapping,
      {
        version: '0.1.0',
        sourcePath: 'package/index.js',
        derivedPath: 'package/decoded-payload.js',
        status: 'MAPPED',
        entries: [{ derivedLine: 14, sourceLine: 7, confidence: 'APPROXIMATE' }],
        derivedLineCount: 14,
        mappedLineCount: 1,
        limitations: [],
      },
    ];

    const result = deterministicNormalizer().normalize(input([], [candidate]));

    expect(result.atomicEvidences[0]?.locations).toEqual([
      expect.objectContaining({
        path: 'package/decoded.js',
        startLine: 12,
        representation: 'DEOBFUSCATED',
        lineageStatus: 'MAPPED',
        derivedFrom: { path: 'package/index.js', startLine: 5, endLine: 5 },
      }),
      expect.objectContaining({
        path: 'package/decoded-payload.js',
        startLine: 14,
        lineageStatus: 'MAPPED',
        derivedFrom: { path: 'package/index.js', startLine: 7, endLine: 7 },
      }),
    ]);
  });

  it('does not normalize raw derived shadow analyzer results without candidates', () => {
    const result = deterministicNormalizer().normalize(
      input([analyzerResult(
        'custom-rule-deobfuscated',
        finding('custom.process-execution', { code: 'exec(decoded)' }),
      )]),
    );

    expect(result.atomicEvidences).toEqual([]);
    expect(result.unmappedFindings).toEqual([
      expect.objectContaining({
        analyzerName: 'custom-rule-deobfuscated',
        ruleId: 'custom.process-execution',
      }),
    ]);
  });

  it('converts GuardDog Capability and Threat Findings to independent Evidence', () => {
    const capability = {
      ...finding(
        'capability-network-outbound',
        { match: 'fetch(', code: 'fetch(url)' },
        { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 3 },
      ),
      findingId: 'guarddog:capability-network-outbound:0',
      type: 'CAPABILITY',
    };
    const threat = {
      ...finding(
        'threat-runtime-environment-read',
        { match: 'process.env', code: 'const token = process.env.TOKEN' },
        { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 4 },
      ),
      findingId: 'guarddog:threat-runtime-environment-read:0',
      type: 'THREAT_INDICATOR',
    };
    const guarddog = {
      ...analyzerResult('guarddog', capability, threat),
      guarddog: {
        risks: [{ name: 'example-risk' }],
        issues: 2,
        toolAssessment: { score: 1, label: 'low' },
      },
    } as AnalyzerResult;

    const result = deterministicNormalizer().normalize(input([guarddog]));

    expect(result.atomicEvidences.map(({ signal }) => signal.type)).toEqual([
      'NETWORK_EGRESS',
      'ENV_READ',
    ]);
    expect(result.atomicEvidences.map(({ signal }) => signal.id)).toEqual([
      'capability.network.outbound',
      'threat.runtime.environment.read',
    ]);
    expect(result.atomicEvidences.map(({ sources }) => sources[0]?.rawFindingId)).toEqual([
      'guarddog:capability-network-outbound:0',
      'guarddog:threat-runtime-environment-read:0',
    ]);
    expect(JSON.stringify(result)).not.toContain('example-risk');
    expect(result.summary.atomicEvidenceCount).toBe(2);
  });

  it('keeps an UNKNOWN GuardDog Finding unmapped even if a Rule is registered', () => {
    const unknown = {
      ...finding('capability-process-spawn', { match: 'spawn(' }),
      findingId: 'guarddog:capability-process-spawn:0',
      type: 'UNKNOWN',
    };

    const result = deterministicNormalizer().normalize(
      input([analyzerResult('guarddog', unknown)]),
    );

    expect(result.atomicEvidences).toEqual([]);
    expect(result.unmappedFindings).toEqual([
      expect.objectContaining({
        findingId: 'guarddog:capability-process-spawn:0',
        analyzerName: 'guarddog',
        mappingStatus: 'UNMAPPED',
      }),
    ]);
  });

  it('creates Atomic Evidence for an EXACT Mapping', () => {
    const result = deterministicNormalizer().normalize(
      input([
        analyzerResult(
          'metadata',
          finding('metadata.lifecycle.postinstall', {
            scriptName: 'postinstall',
            scriptValue: 'node setup.js',
            observation: 'PRESENT',
          }, { type: 'METADATA', jsonPointer: '/scripts/postinstall' }),
        ),
      ]),
    );

    expect(result.atomicEvidences).toHaveLength(1);
    expect(result.atomicEvidences[0]).toMatchObject({
      evidenceId: 'evidence-1',
      kind: 'ATOMIC',
      signal: {
        id: 'capability.lifecycle.postinstall',
        type: 'POSTINSTALL_SCRIPT',
        category: 'METADATA',
      },
      assertion: { basis: 'METADATA_VALUE' },
      sources: [
        {
          analyzer: 'metadata',
          ruleId: 'metadata.lifecycle.postinstall',
          rawFindingId: 'finding-1',
        },
      ],
      locations: [
        { type: 'METADATA', jsonPointer: '/scripts/postinstall' },
      ],
    });
    expect(result.summary).toMatchObject({
      inputFindingCount: 1,
      normalizedFindingCount: 1,
      atomicEvidenceCount: 1,
      unmappedFindingCount: 0,
      invalidFindingCount: 0,
    });
  });

  it('copies taxonomy and action from a Mapping Target without changing Raw Finding', () => {
    const registry = new EvidenceMappingRegistry([
      {
        analyzerName: 'custom-rule',
        ruleId: 'custom.test.taxonomy',
        mappingStatus: 'EXACT',
        targets: [{
          signalId: 'capability.network.outbound',
          signalType: 'NETWORK_EGRESS',
          signalCategory: 'NETWORK',
          taxonomy: 'CREDENTIAL_AND_SENSITIVE_DATA_ACCESS',
          action: 'ENVIRONMENT_EXFILTRATION',
          assertionBasis: 'DATA_FLOW',
          limitations: ['runtime transfer not verified'],
        }],
        mappingVersion: EVIDENCE_MAPPING_VERSION,
      },
    ]);
    const rawFinding = finding('custom.test.taxonomy', { code: 'request(body)' });

    const result = deterministicNormalizer(registry).normalize(
      input([analyzerResult('custom-rule', rawFinding)]),
    );

    expect(rawFinding).not.toHaveProperty('taxonomy');
    expect(result.atomicEvidences[0]).toMatchObject({
      taxonomy: 'CREDENTIAL_AND_SENSITIVE_DATA_ACCESS',
      action: 'ENVIRONMENT_EXFILTRATION',
      signal: { category: 'NETWORK', type: 'NETWORK_EGRESS' },
      assertion: { basis: 'DATA_FLOW' },
      sources: [{ rawFindingId: 'finding-1' }],
    });
  });

  it('normalizes a P0 Custom Rule Finding using Registry taxonomy/action', () => {
    const result = deterministicNormalizer().normalize(input([
      analyzerResult('custom-rule', finding('custom.credential-source', {
        actionHint: 'CREDENTIAL_ACCESS',
        sourceType: 'CREDENTIAL_ENVIRONMENT',
        reviewStatus: 'PENDING',
      }, {
        type: 'SOURCE_FILE',
        path: 'package/index.js',
        startLine: 2,
      })),
    ]));

    expect(result.atomicEvidences[0]).toMatchObject({
      taxonomy: 'CREDENTIAL_AND_SENSITIVE_DATA_ACCESS',
      action: 'CREDENTIAL_ACCESS',
      signal: { type: 'CREDENTIAL_READ', category: 'ENVIRONMENT' },
      sources: [{ rawFindingId: 'finding-1' }],
      locations: [{ path: 'package/index.js', startLine: 2 }],
    });
  });

  it('normalizes a GuardDog 1:N PARTIAL Mapping with separate signalCategory and taxonomy values', () => {
    const guardDogFinding = {
      ...finding('threat-network-exfil-sysinfo', {}, {
        type: 'SOURCE_FILE' as const,
        path: 'package/index.js',
        startLine: 12,
      }),
      findingId: 'guarddog:threat-network-exfil-sysinfo:0',
    };

    const result = deterministicNormalizer().normalize(
      input([analyzerResult('guarddog', guardDogFinding)]),
    );

    expect(result.atomicEvidences).toHaveLength(2);
    expect(result.atomicEvidences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        signal: { type: 'SYSTEM_INFO', category: 'SYSTEM', id: 'threat.system.information-collection' },
        taxonomy: 'DISCOVERY_AND_COLLECTION',
        action: 'SYSTEM_INFORMATION_COLLECTION',
        assertion: expect.objectContaining({ basis: 'CO_OCCURRENCE' }),
      }),
      expect.objectContaining({
        signal: { type: 'NETWORK_EGRESS', category: 'NETWORK', id: 'threat.network.system-info-egress' },
        taxonomy: 'NETWORK_C2_AND_EXFILTRATION',
        action: 'SYSTEM_INFORMATION_EXFILTRATION_CANDIDATE',
        assertion: expect.objectContaining({ basis: 'CO_OCCURRENCE' }),
      }),
    ]));
  });

  it('deduplicates each GuardDog 1:N target while preserving both raw Finding IDs', () => {
    const location = {
      type: 'SOURCE_FILE' as const,
      path: 'package/index.js',
      startLine: 12,
    };
    const first = {
      ...finding('threat-network-exfil-sysinfo', {}, location),
      findingId: 'guarddog:threat-network-exfil-sysinfo:0',
    };
    const second = {
      ...finding('threat-network-exfil-sysinfo', {}, location),
      findingId: 'guarddog:threat-network-exfil-sysinfo:1',
    };

    const result = deterministicNormalizer().normalize(
      input([analyzerResult('guarddog', first, second)]),
    );

    expect(result.atomicEvidences).toHaveLength(2);
    expect(result.summary.deduplicatedEvidenceCount).toBe(2);
    for (const evidence of result.atomicEvidences) {
      expect(evidence.sources.map(({ rawFindingId }) => rawFindingId).sort()).toEqual([
        'guarddog:threat-network-exfil-sysinfo:0',
        'guarddog:threat-network-exfil-sysinfo:1',
      ]);
    }
  });

  it('preserves an UNMAPPED GuardDog Finding and its raw provenance', () => {
    const guardDogFinding = {
      ...finding('capability-process-schedule', {}, {
        type: 'SOURCE_FILE' as const,
        path: 'package/index.js',
        startLine: 8,
      }),
      findingId: 'guarddog:capability-process-schedule:0',
      rawResultRef: 'raw://guarddog/result-0',
    };

    const result = deterministicNormalizer().normalize(
      input([analyzerResult('guarddog', guardDogFinding)]),
    );

    expect(result.atomicEvidences).toEqual([]);
    expect(result.unmappedFindings).toEqual([
      expect.objectContaining({
        findingId: 'guarddog:capability-process-schedule:0',
        analyzerName: 'guarddog',
        ruleId: 'capability-process-schedule',
        mappingStatus: 'UNMAPPED',
        reason: 'No Evidence mapping is registered for this Analyzer and Rule ID',
        location: { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 8 },
        rawResultRef: 'raw://guarddog/result-0',
        signal: null,
        taxonomy: null,
      }),
    ]);
  });

  it('normalizes a Metadata mismatch Finding with its cross-source assertion', () => {
    const result = deterministicNormalizer().normalize(
      input([
        analyzerResult(
          'metadata',
          {
            ...finding('metadata.license.mismatch', {
              field: 'license',
              packageJsonValue: 'MIT',
              registryMetadataValue: 'Apache-2.0',
              observation: 'MISMATCH',
            }, { type: 'METADATA', jsonPointer: '/license' }),
            type: 'METADATA_MISMATCH',
            message: 'Registry version manifest license "Apache-2.0" does not match tarball package.json license "MIT"',
          },
        ),
      ]),
    );

    expect(result.atomicEvidences).toMatchObject([
      {
        signal: {
          id: 'consistency.metadata.license-mismatch',
          type: 'METADATA_MISMATCH',
          category: 'METADATA',
        },
        assertion: {
          basis: 'METADATA_VALUE',
          summary: expect.stringContaining('tarball package.json license'),
        },
        locations: [{ type: 'METADATA', jsonPointer: '/license' }],
        limitations: [expect.stringContaining('does not by itself prove tampering')],
      },
    ]);
    expect(result.unmappedFindings).toEqual([]);
    expect(result.summary.unmappedFindingCount).toBe(0);
  });

  it.each(['preinstall', 'install'] as const)(
    'normalizes metadata.lifecycle.%s to its dedicated lifecycle Signal ID',
    (scriptName) => {
      const result = deterministicNormalizer().normalize(
        input([
          analyzerResult(
            'metadata',
            finding(
              `metadata.lifecycle.${scriptName}`,
              {
                scriptName,
                scriptValue: `node ${scriptName}.js`,
                observation: 'PRESENT',
              },
              { type: 'METADATA', jsonPointer: `/scripts/${scriptName}` },
            ),
          ),
        ]),
      );

      expect(result.atomicEvidences).toMatchObject([
        expect.objectContaining({
          signal: expect.objectContaining({
            id: `capability.lifecycle.${scriptName}`,
            type: `${scriptName.toUpperCase()}_SCRIPT`,
          }),
        }),
      ]);
      expect(result.unmappedFindings).toEqual([]);
      expect(result.summary.unmappedFindingCount).toBe(0);
    },
  );

  it('records limitations for a PARTIAL Mapping', () => {
    const result = deterministicNormalizer().normalize(
      input([
        analyzerResult(
          'custom-rule',
          finding(
            'custom.sensitive-file-access',
            {
              interpretation: 'STATIC_PATTERN',
              signalRuleIds: ['custom.signal.sensitive-file-access'],
              doesNotProve: 'Sensitive data was read',
            },
            { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 2 },
          ),
        ),
      ]),
    );

    expect(result.atomicEvidences[0]).toMatchObject({
      signal: { type: 'SENSITIVE_FILE_READ' },
      assertion: { basis: 'PATTERN_MATCH' },
      limitations: [expect.stringContaining('does not prove')],
      locations: [
        { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 2 },
      ],
    });
  });

  it('creates two Atomic Evidence items from a Mapping with two targets', () => {
    const result = deterministicNormalizer().normalize(
      input([
        analyzerResult(
          'custom-rule',
          finding('custom.env-network-coexistence', {
            interpretation: 'CO_OCCURRENCE_ONLY',
            signalRuleIds: [
              'custom.signal.environment-access',
              'custom.signal.network-access',
            ],
            doesNotProve: 'Data flow',
          }),
        ),
      ]),
    );

    expect(result.atomicEvidences.map(({ signal }) => signal.id)).toEqual([
      'capability.environment.read',
      'capability.network.outbound',
    ]);
    expect(result.atomicEvidences).toHaveLength(2);
    expect(result.atomicEvidences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          limitations: [expect.stringContaining('data flow')],
          sources: [expect.objectContaining({ rawFindingId: 'finding-1' })],
        }),
      ]),
    );
    expect(
      result.atomicEvidences.every(
        ({ sources }) => sources[0]?.rawFindingId === 'finding-1',
      ),
    ).toBe(true);
    expect(result.summary.normalizedFindingCount).toBe(1);
    expect(result.summary.atomicEvidenceCount).toBe(2);
  });

  it('maps lifecycle-process coexistence only to limited process Capability Evidence', () => {
    const result = deterministicNormalizer().normalize(
      input([
        analyzerResult(
          'custom-rule',
          finding(
            'custom.lifecycle-process-coexistence',
            {
              interpretation: 'CO_OCCURRENCE_ONLY',
              signalRuleIds: ['custom.signal.process-access'],
              doesNotProve: 'Execution order, linkage, or actual execution',
            },
            { type: 'METADATA', jsonPointer: '/scripts/postinstall' },
          ),
        ),
      ]),
    );

    expect(result.atomicEvidences).toHaveLength(1);
    expect(result.atomicEvidences[0]).toMatchObject({
      signal: { id: 'capability.process.spawn', type: 'CHILD_PROCESS' },
      assertion: { basis: 'CO_OCCURRENCE' },
      limitations: [expect.stringMatching(/execution order.*not proven/iu)],
    });
    expect(result.atomicEvidences[0]?.signal.id).not.toBe(
      'capability.lifecycle.postinstall',
    );
  });

  it('maps sensitive-file-network coexistence to two limited independent signals', () => {
    const result = deterministicNormalizer().normalize(
      input([
        analyzerResult(
          'custom-rule',
          finding('custom.sensitive-file-network-coexistence', {
            interpretation: 'CO_OCCURRENCE_ONLY',
            signalRuleIds: [
              'custom.signal.sensitive-file-access',
              'custom.signal.network-access',
            ],
            doesNotProve: 'Sensitive file contents were sent to the network',
          }),
        ),
      ]),
    );

    expect(result.atomicEvidences.map(({ signal }) => signal.id)).toEqual([
      'capability.filesystem.sensitive-read',
      'capability.network.outbound',
    ]);
    expect(
      result.atomicEvidences.every(
        ({ limitations, sources }) =>
          limitations.some((value) => value.includes('not proven')) &&
          sources[0]?.rawFindingId === 'finding-1',
      ),
    ).toBe(true);
  });

  it('preserves a Finding as UNMAPPED when no Mapping is registered', () => {
    const rawFinding = {
      ...finding('metadata.lifecycle.unknown', {
        scriptName: 'unknown',
        scriptValue: 'node unknown.js',
        observation: 'PRESENT',
      }, {
        type: 'METADATA' as const,
        jsonPointer: '/scripts/unknown',
      }),
      rawResultRef: 'raw://metadata/finding-1',
    };
    const result = deterministicNormalizer().normalize(
      input([
        analyzerResult('metadata', rawFinding),
      ]),
    );

    expect(result.atomicEvidences).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.unmappedFindings).toEqual([
      expect.objectContaining({
        findingId: 'finding-1',
        analyzerName: 'metadata',
        ruleId: 'metadata.lifecycle.unknown',
        mappingStatus: 'UNMAPPED',
        reason: 'No Evidence mapping is registered for this Analyzer and Rule ID',
        location: { type: 'METADATA', jsonPointer: '/scripts/unknown' },
        rawResultRef: 'raw://metadata/finding-1',
      }),
    ]);
    expect(result.summary).toMatchObject({
      inputFindingCount: 1,
      normalizedFindingCount: 0,
      unmappedFindingCount: 1,
    });
  });

  it('preserves an AMBIGUOUS Mapping without creating Evidence', () => {
    const ambiguousRule: EvidenceMappingRule = {
      analyzerName: 'metadata',
      ruleId: 'metadata.lifecycle.postinstall',
      mappingStatus: 'AMBIGUOUS',
      targets: [],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
      reason: 'The Finding has more than one possible common meaning',
    };
    const normalizer = deterministicNormalizer(
      new EvidenceMappingRegistry([ambiguousRule]),
    );

    const result = normalizer.normalize(
      input([
        analyzerResult(
          'metadata',
          finding('metadata.lifecycle.postinstall', {}),
        ),
      ]),
    );

    expect(result.atomicEvidences).toEqual([]);
    expect(result.unmappedFindings).toEqual([
      expect.objectContaining({
        mappingStatus: 'AMBIGUOUS',
        reason: ambiguousRule.reason,
      }),
    ]);
  });

  it('preserves an INVALID Mapping as an explicit unmapped result', () => {
    const registry = new EvidenceMappingRegistry([{
      analyzerName: 'metadata',
      ruleId: 'metadata.invalid',
      mappingStatus: 'INVALID',
      targets: [],
      mappingVersion: EVIDENCE_MAPPING_VERSION,
      reason: 'Mapping target classification is invalid',
    }]);

    const result = deterministicNormalizer(registry).normalize(
      input([analyzerResult('metadata', finding('metadata.invalid', {}, {
        type: 'METADATA',
        jsonPointer: '/scripts/install',
      }))]),
    );

    expect(result.unmappedFindings).toEqual([
      expect.objectContaining({
        findingId: 'finding-1',
        mappingStatus: 'INVALID',
        signal: null,
        taxonomy: null,
        location: { type: 'METADATA', jsonPointer: '/scripts/install' },
      }),
    ]);
  });

  it('records an INVALID Finding without stopping remaining Findings', () => {
    const invalidResult = analyzerResult(
      'metadata',
      finding('metadata.lifecycle.postinstall', {}),
    );
    invalidResult.findings.unshift({ ruleId: '' } as never);

    const result = deterministicNormalizer().normalize(input([invalidResult]));

    expect(result.atomicEvidences).toHaveLength(1);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: 'INTERNAL_ERROR',
        stage: 'NORMALIZATION:INVALID_FINDING',
        analyzer: 'metadata',
        retryable: false,
      }),
    ]);
    expect(result.summary).toMatchObject({
      inputFindingCount: 2,
      normalizedFindingCount: 1,
      invalidFindingCount: 1,
    });
  });

  it('deduplicates equivalent Findings and retains each raw Finding ID', () => {
    const first = finding('custom.sensitive-file-access', {
      interpretation: 'STATIC_PATTERN',
      signalRuleIds: ['custom.signal.sensitive-file-access'],
      doesNotProve: 'Sensitive data was read',
    });
    const second = { ...first, findingId: 'finding-2' };

    const result = deterministicNormalizer().normalize(
      input([analyzerResult('custom-rule', first, second)]),
    );

    expect(result.atomicEvidences).toHaveLength(1);
    expect(result.atomicEvidences[0]?.sources).toEqual([
      expect.objectContaining({ rawFindingId: 'finding-1' }),
      expect.objectContaining({ rawFindingId: 'finding-2' }),
    ]);
    expect(result.summary.deduplicatedEvidenceCount).toBe(1);
  });

  it.each([
    [
      'different Location',
      finding(
        'custom.sensitive-file-access',
        {
          interpretation: 'STATIC_PATTERN',
          signalRuleIds: ['custom.signal.sensitive-file-access'],
          doesNotProve: 'Sensitive data was read',
        },
        { type: 'SOURCE_FILE', path: 'package/other.js', startLine: 2 },
      ),
    ],
    [
      'different match/code content',
      finding('custom.sensitive-file-access', {
        interpretation: 'STATIC_PATTERN',
        signalRuleIds: ['custom.signal.sensitive-file-access'],
        doesNotProve: 'A different observation',
        code: 'different code',
      }, { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 2 }),
    ],
  ] as const)('does not deduplicate the same Rule with %s', (_case, second) => {
    const first = finding(
      'custom.sensitive-file-access',
      {
        interpretation: 'STATIC_PATTERN',
        signalRuleIds: ['custom.signal.sensitive-file-access'],
        doesNotProve: 'Sensitive data was read',
        code: 'original code',
      },
      { type: 'SOURCE_FILE', path: 'package/index.js', startLine: 2 },
    );

    const result = deterministicNormalizer().normalize(
      input([
        analyzerResult(
          'custom-rule',
          first,
          { ...second, findingId: 'finding-2' },
        ),
      ]),
    );

    expect(result.atomicEvidences).toHaveLength(2);
    expect(result.summary.deduplicatedEvidenceCount).toBe(0);
  });

  it('keeps the same Signal from different Analyzers as independent Evidence', () => {
    const sharedTarget = {
      signalId: 'capability.shared.test',
      signalType: 'CHILD_PROCESS' as const,
      signalCategory: 'EXECUTION',
      assertionBasis: 'PATTERN_MATCH' as const,
      limitations: [],
    };
    const registry = new EvidenceMappingRegistry([
      {
        analyzerName: 'metadata',
        ruleId: 'metadata.lifecycle.postinstall',
        mappingStatus: 'EXACT',
        targets: [sharedTarget],
        mappingVersion: EVIDENCE_MAPPING_VERSION,
      },
      {
        analyzerName: 'custom-rule',
        ruleId: 'custom.lifecycle-process-coexistence',
        mappingStatus: 'EXACT',
        targets: [sharedTarget],
        mappingVersion: EVIDENCE_MAPPING_VERSION,
      },
    ]);

    const result = deterministicNormalizer(registry).normalize(
      input([
        analyzerResult(
          'metadata',
          finding('metadata.lifecycle.postinstall', {
            scriptName: 'postinstall',
            scriptValue: 'node setup.js',
            observation: 'PRESENT',
          }),
        ),
        analyzerResult(
          'custom-rule',
          finding('custom.lifecycle-process-coexistence', {
            interpretation: 'CO_OCCURRENCE_ONLY',
            signalRuleIds: ['custom.signal.process-access'],
            doesNotProve: 'Actual execution',
          }),
        ),
      ]),
    );

    expect(result.atomicEvidences).toHaveLength(2);
    expect(
      result.atomicEvidences.map(({ sources }) => sources[0]?.analyzer),
    ).toEqual(['metadata', 'custom-rule']);
    expect(result.summary.deduplicatedEvidenceCount).toBe(0);
  });

  it('normalizes an absolute Artifact path and preserves Contract coordinates', () => {
    const result = deterministicNormalizer().normalize(
      input([
        analyzerResult(
          'custom-rule',
          finding(
            'custom.sensitive-file-access',
            {
              interpretation: 'STATIC_PATTERN',
              signalRuleIds: ['custom.signal.sensitive-file-access'],
              doesNotProve: 'Sensitive data was read',
            },
            {
              type: 'SOURCE_FILE',
              path: '/tmp/scanner/scan-1/extracted/package/index.js',
              startLine: 12,
              startColumn: 4,
            },
          ),
        ),
      ]),
    );

    expect(result.atomicEvidences[0]?.locations).toEqual([
      {
        type: 'SOURCE_FILE',
        path: 'package/index.js',
        startLine: 12,
        startColumn: 4,
      },
    ]);
    expect(JSON.stringify(result.atomicEvidences)).not.toContain('/tmp/');
  });

  it.each([
    ['/tmp/scanner/scan-1/outside.js'],
    ['package/../outside.js'],
  ])('rejects an outside Location or parent path segment: %s', (path) => {
    const result = deterministicNormalizer().normalize(
      input([
        analyzerResult(
          'custom-rule',
          finding(
            'custom.sensitive-file-access',
            {
              interpretation: 'STATIC_PATTERN',
              signalRuleIds: ['custom.signal.sensitive-file-access'],
              doesNotProve: 'Sensitive data was read',
            },
            { type: 'SOURCE_FILE', path },
          ),
        ),
      ]),
    );

    expect(result.atomicEvidences).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ stage: 'NORMALIZATION:INVALID_LOCATION' }),
    ]);
    expect(result.summary.invalidFindingCount).toBe(1);
  });

  it('keeps Mapping Hash independent from Evidence UUID and observation time', () => {
    const first = deterministicNormalizer().normalize(
      input([
        analyzerResult(
          'metadata',
          finding('metadata.lifecycle.postinstall', {}),
        ),
      ]),
    );
    const second = new EvidenceNormalizer(
      new EvidenceMappingRegistry(),
      () => 'another-evidence-id',
      () => new Date('2030-01-01T00:00:00.000Z'),
    ).normalize(
      input([
        analyzerResult(
          'metadata',
          finding('metadata.lifecycle.postinstall', {}),
        ),
      ]),
    );

    expect(first.atomicEvidences[0]?.evidenceId).not.toBe(
      second.atomicEvidences[0]?.evidenceId,
    );
    expect(first.atomicEvidences[0]?.provenance.observedAt).not.toBe(
      second.atomicEvidences[0]?.provenance.observedAt,
    );
    expect(first.summary.mappingHash).toBe(second.summary.mappingHash);
  });

  it('keeps Evidence Instance UUID separate from the stable Signal ID', () => {
    const result = new EvidenceNormalizer().normalize(
      input([
        analyzerResult(
          'metadata',
          finding('metadata.lifecycle.postinstall', {}),
        ),
      ]),
    );
    const evidence = result.atomicEvidences[0];

    expect(evidence?.evidenceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(evidence?.signal.id).toBe('capability.lifecycle.postinstall');
    expect(evidence?.evidenceId).not.toBe(evidence?.signal.id);
    expect(evidence?.subject).toEqual({
      ecosystem: 'npm',
      packageName: 'example',
      packageVersion: '1.0.0',
      artifactHash: 'abcdef0123456789',
    });
    expect(evidence?.sources).toEqual([
      expect.objectContaining({
        analyzer: 'metadata',
        analyzerVersion: '0.1.0',
        rawFindingId: 'finding-1',
      }),
    ]);
  });

  it('uses Contract field names and adds no Mapping metadata to Provenance', () => {
    const result = deterministicNormalizer().normalize(
      input([
        analyzerResult(
          'metadata',
          finding('metadata.lifecycle.postinstall', {}),
        ),
      ]),
    );
    const evidence = result.atomicEvidences[0];

    expect(Object.keys(evidence ?? {}).sort()).toEqual([
      'assertion',
      'evidenceId',
      'kind',
      'limitations',
      'locations',
      'provenance',
      'schemaVersion',
      'signal',
      'sources',
      'subject',
    ]);
    expect(evidence?.provenance).toEqual({
      scanId: 'scan-1',
      generatedBy: 'EVIDENCE_NORMALIZER',
      observedAt: '2026-08-25T00:00:00.000Z',
    });
    expect(evidence?.provenance).not.toHaveProperty('mappingVersion');
    expect(evidence?.provenance).not.toHaveProperty('mappingHash');
    expect(evidence?.provenance).not.toHaveProperty('rawResultRef');
    expect(evidence?.sources[0]).toMatchObject({
      analyzer: 'metadata',
      analyzerVersion: '0.1.0',
    });
  });
});

function deterministicNormalizer(
  registry = new EvidenceMappingRegistry(),
): EvidenceNormalizer {
  let nextId = 1;
  return new EvidenceNormalizer(
    registry,
    () => `evidence-${nextId++}`,
    () => new Date('2026-08-25T00:00:00.000Z'),
  );
}

function input(
  analyzerResults: AnalyzerResult[],
  tier2Candidates: readonly Tier2EvidenceCandidateInput[] = [],
): NormalizationInput {
  return {
    requestId: 'request-1',
    scanId: 'scan-1',
    subject: {
      ecosystem: 'npm',
      packageName: 'example',
      packageVersion: '1.0.0',
      artifactHash: 'abcdef0123456789',
    },
    artifactRoot: '/tmp/scanner/scan-1/extracted',
    analyzerResults,
    ...(tier2Candidates.length === 0 ? {} : { tier2Candidates }),
  };
}

function tier2CandidateValue(
  analyzer: 'custom-rule-deobfuscated' | 'guarddog-deobfuscated',
  ruleId: string,
  findingId: string,
  restoreStatus: Tier2EvidenceCandidateInput['restoreStatus'],
): Tier2EvidenceCandidateInput {
  return {
    requestId: 'request-1',
    scanId: 'scan-1',
    artifactHash: 'abcdef0123456789',
    analyzer,
    analyzerVersion: analyzer === 'guarddog-deobfuscated' ? 'guarddog-v1' : 'custom-v1',
    ruleId,
    rawFindingId: findingId,
    finding: {
      ...finding(ruleId, { code: 'exec(decoded)' }),
      findingId,
      type: 'CAPABILITY',
    },
    locations: [
      { type: 'SOURCE_FILE', path: 'package/decoded.js', startLine: 12 },
      { type: 'SOURCE_FILE', path: 'package/decoded-payload.js', startLine: 14 },
    ],
    originalPath: 'package/index.js',
    originalPaths: ['package/index.js', 'package/index.js'],
    restoreStatus,
    limitations: ['STRING_STAGE_FAILED'],
  };
}

function analyzerResult(
  analyzer: string,
  ...findings: Finding[]
): AnalyzerResult {
  return {
    requestId: 'request-1',
    scanId: 'scan-1',
    analyzer,
    analyzerVersion: '0.1.0',
    status: 'SUCCESS',
    findings,
    errors: [],
  };
}

function finding(
  ruleId: string,
  data: Record<string, unknown>,
  location?: Finding['location'],
): Finding {
  return {
    findingId: 'finding-1',
    ruleId,
    type: 'TEST_FINDING',
    message: `Finding for ${ruleId}`,
    ...(location === undefined ? {} : { location }),
    data,
  };
}
