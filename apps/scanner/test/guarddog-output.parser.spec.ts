import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseGuardDogOutput } from '../src/analyzers/guarddog/guarddog-output.parser';
import { GuardDogOutputParserError } from '../src/analyzers/guarddog/guarddog.types';

const fixture = (name: string): string => readFileSync(
  join(__dirname, 'fixtures', 'guarddog', name),
  'utf8',
);

function guardDogOutput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    package: '/tmp/scanner/scan-1/extracted',
    issues: 0,
    errors: {},
    results: {},
    risk_score: {
      score: 0,
      label: 'no_risks_detected',
      findings_count: 0,
      score_breakdown: {},
    },
    risks: [],
    ...overrides,
  };
}

function sourceFinding(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    location: 'package/index.js:12',
    code: 'fetch(url)',
    match: 'fetch',
    message: 'Outbound network capability detected',
    ...overrides,
  };
}

function parse(overrides: Record<string, unknown> = {}) {
  return parseGuardDogOutput(JSON.stringify(guardDogOutput(overrides)));
}

function expectParserError(
  stdout: string,
  kind: GuardDogOutputParserError['kind'],
): void {
  try {
    parseGuardDogOutput(stdout);
    throw new Error('Expected GuardDog output parsing to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(GuardDogOutputParserError);
    expect(error).toMatchObject({ kind });
  }
}

describe('parseGuardDogOutput', () => {
  describe('GuardDog 3.1.0 runtime fixtures', () => {
    it('parses the observed clean source scan', () => {
      const result = parseGuardDogOutput(fixture('guarddog-3.1.0-clean.json'));

      expect(result).toMatchObject({
        issues: 0,
        findings: [],
        reportedErrors: [],
        warnings: [],
        risks: [],
        toolAssessment: {
          score: 0,
          label: 'no_risks_detected',
          findingsCount: 0,
        },
      });
    });

    it('parses observed capability, threat, and risk output', () => {
      const result = parseGuardDogOutput(fixture('guarddog-3.1.0-detected.json'));

      expect(result.findings.map(({ findingId, type, location }) => ({
        findingId,
        type,
        location,
      }))).toEqual([
        {
          findingId: 'guarddog:capability-network-outbound:0',
          type: 'CAPABILITY',
          location: { type: 'SOURCE_FILE', path: 'index.js', startLine: 1 },
        },
        {
          findingId: 'guarddog:capability-process-spawn:0',
          type: 'CAPABILITY',
          location: { type: 'SOURCE_FILE', path: 'index.js', startLine: 2 },
        },
        {
          findingId: 'guarddog:threat-runtime-environment-read:0',
          type: 'THREAT_INDICATOR',
          location: { type: 'SOURCE_FILE', path: 'index.js', startLine: 5 },
        },
      ]);
      expect(result.risks).toHaveLength(1);
      expect(result.toolAssessment).toMatchObject({
        score: 3.3,
        label: 'low',
        findingsCount: 4,
      });
      expect(result.hasRuleInterpretationFailures).toBe(false);
    });

    it('preserves observed GuardDog reported errors for Analyzer conversion', () => {
      const result = parseGuardDogOutput(fixture('guarddog-3.1.0-error.json'));

      expect(result.reportedErrors).toEqual([{
        ruleOrStage: 'threat-broken-rule',
        message: 'failed to run rule: fixture error',
      }]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('valid output', () => {
    it('parses a no-finding result without inventing failures', () => {
      const result = parse();

      expect(result).toMatchObject({
        package: '/tmp/scanner/scan-1/extracted',
        issues: 0,
        findings: [],
        reportedErrors: [],
        warnings: [],
        risks: [],
        hasRuleInterpretationFailures: false,
      });
      expect(result.toolAssessment).toMatchObject({
        score: 0,
        label: 'no_risks_detected',
        findingsCount: 0,
        scoreBreakdown: {},
      });
    });

    it('converts a capability finding and its safe source location', () => {
      const rawFinding = sourceFinding();
      const result = parse({
        results: { 'capability-network-outbound': [rawFinding] },
      });

      expect(result.findings).toEqual([{
        findingId: 'guarddog:capability-network-outbound:0',
        ruleId: 'capability-network-outbound',
        type: 'CAPABILITY',
        message: 'Outbound network capability detected',
        location: {
          type: 'SOURCE_FILE',
          path: 'package/index.js',
          startLine: 12,
        },
        data: {
          code: 'fetch(url)',
          match: 'fetch',
          guarddog: {
            resultRuleId: 'capability-network-outbound',
            rawResult: rawFinding,
          },
        },
      }]);
    });

    it('converts a threat finding without claiming that code executed', () => {
      const result = parse({
        results: {
          'threat-runtime-environment-read': [{ location: 'package/env.js:3' }],
        },
      });

      expect(result.findings[0]).toMatchObject({
        findingId: 'guarddog:threat-runtime-environment-read:0',
        type: 'THREAT_INDICATOR',
        message: expect.stringContaining('reported a static finding'),
      });
      expect(result.findings[0]?.message).not.toContain('executed');
    });

    it('preserves capability and threat findings in sorted rule order', () => {
      const result = parse({
        results: {
          'threat-runtime-environment-read': [
            sourceFinding({ message: 'threat first' }),
          ],
          'capability-network-outbound': [
            sourceFinding({ message: 'capability first' }),
            sourceFinding({ message: 'capability second' }),
          ],
        },
      });

      expect(result.findings.map(({ findingId, message }) => ({ findingId, message }))).toEqual([
        {
          findingId: 'guarddog:capability-network-outbound:0',
          message: 'capability first',
        },
        {
          findingId: 'guarddog:capability-network-outbound:1',
          message: 'capability second',
        },
        {
          findingId: 'guarddog:threat-runtime-environment-read:0',
          message: 'threat first',
        },
      ]);
    });

    it('converts an unclassified rule to an UNKNOWN finding', () => {
      const result = parse({
        results: { 'experimental-static-rule': [sourceFinding()] },
      });

      expect(result.findings[0]).toMatchObject({
        ruleId: 'experimental-static-rule',
        type: 'UNKNOWN',
      });
    });

    it.each([
      ['empty array', []],
      ['empty object', {}],
    ])('treats %s as a normal rule with no findings', (_name, ruleResult) => {
      const result = parse({ results: { 'capability-unused': ruleResult } });

      expect(result.findings).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('preserves valid risk objects without turning them into findings', () => {
      const risk = {
        name: 'Environment data with outbound access',
        severity: 'HIGH',
        threat_rule: 'threat-runtime-environment-read',
        unknown_future_field: { preserved: true },
      };
      const result = parse({ risks: [risk] });

      expect(result.risks).toEqual([risk]);
      expect(result.findings).toEqual([]);
    });

    it('maps risk_score fields and preserves its source object', () => {
      const riskScore = {
        score: 42.5,
        label: 'suspicious',
        findings_count: 7,
        score_breakdown: { threat: 40, capability: 2.5 },
        future_field: 'preserved',
      };
      const result = parse({ risk_score: riskScore });

      expect(result.toolAssessment).toEqual({
        score: 42.5,
        label: 'suspicious',
        findingsCount: 7,
        scoreBreakdown: { threat: 40, capability: 2.5 },
        raw: riskScore,
      });
    });

    it('allows unknown top-level fields without retaining the full output', () => {
      const result = parse({ future_top_level_field: { ignored: true } });

      expect(result).not.toHaveProperty('future_top_level_field');
    });
  });

  describe('partial interpretation', () => {
    it('records an unsupported rule shape without failing the whole output', () => {
      const result = parse({ results: { 'capability-invalid': 'unexpected' } });

      expect(result.findings).toEqual([]);
      expect(result.hasRuleInterpretationFailures).toBe(true);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          kind: 'UNSUPPORTED_RULE_RESULT',
          ruleId: 'capability-invalid',
        }),
      ]);
    });

    it('does not assume a non-empty object is a single-finding result', () => {
      const result = parse({
        results: { 'capability-single-object': sourceFinding() },
      });

      expect(result.findings).toEqual([]);
      expect(result.warnings).toEqual([
        expect.objectContaining({
          kind: 'UNSUPPORTED_RULE_RESULT',
          ruleId: 'capability-single-object',
        }),
      ]);
    });

    it('keeps valid findings when another rule cannot be interpreted', () => {
      const result = parse({
        results: {
          'threat-invalid': 123,
          'capability-network-outbound': [sourceFinding()],
        },
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.ruleId).toBe('capability-network-outbound');
      expect(result.hasRuleInterpretationFailures).toBe(true);
    });

    it('skips a non-object array item while keeping its original occurrence index', () => {
      const result = parse({
        results: {
          'threat-mixed': ['invalid', sourceFinding({ message: 'valid' })],
        },
      });

      expect(result.findings[0]?.findingId).toBe('guarddog:threat-mixed:1');
      expect(result.warnings).toEqual([
        expect.objectContaining({ kind: 'INVALID_FINDING', occurrenceIndex: 0 }),
      ]);
    });

    it('preserves findings while converting GuardDog reported errors', () => {
      const result = parse({
        results: { 'threat-runtime-environment-read': [sourceFinding()] },
        errors: { 'threat-broken-rule': 'rule could not be evaluated' },
      });

      expect(result.findings).toHaveLength(1);
      expect(result.reportedErrors).toEqual([{
        ruleOrStage: 'threat-broken-rule',
        message: 'rule could not be evaluated',
      }]);
    });

    it('uses a safe fallback for a non-string GuardDog error value', () => {
      const result = parse({ errors: { loader: { detail: 'unexpected' } } });

      expect(result.reportedErrors).toEqual([{
        ruleOrStage: 'loader',
        message: 'GuardDog reported an error for "loader"',
      }]);
      expect(result.warnings).toEqual([
        expect.objectContaining({ kind: 'INVALID_REPORTED_ERROR', ruleId: 'loader' }),
      ]);
    });

    it('keeps valid risks and records primitive risk entries', () => {
      const validRisk = { name: 'valid-risk', severity: 'LOW' };
      const result = parse({ risks: ['invalid', validRisk, null] });

      expect(result.risks).toEqual([validRisk]);
      expect(result.warnings).toEqual([
        expect.objectContaining({ kind: 'INVALID_RISK', riskIndex: 0 }),
        expect.objectContaining({ kind: 'INVALID_RISK', riskIndex: 2 }),
      ]);
    });

    it.each([
      ['missing', undefined],
      ['not a string', 12],
      ['without a line', 'package/index.js'],
      ['with line zero', 'package/index.js:0'],
    ])('omits a location that is %s', (_name, location) => {
      const result = parse({ results: { 'capability-location': [sourceFinding({ location })] } });

      expect(result.findings[0]).not.toHaveProperty('location');
      if (location === undefined) {
        expect(result.findings[0]?.data.guarddog.rawResult).not.toHaveProperty('location');
      } else {
        expect(result.findings[0]?.data.guarddog.rawResult).toHaveProperty('location', location);
      }
    });
  });

  describe('invalid top-level output', () => {
    it.each([
      ['empty stdout', '   ', 'EMPTY_OUTPUT'],
      ['invalid JSON', '{not-json', 'INVALID_JSON'],
      ['array', '[]', 'INVALID_TOP_LEVEL'],
      ['primitive', '42', 'INVALID_TOP_LEVEL'],
      [
        'invalid results',
        JSON.stringify(guardDogOutput({ results: [] })),
        'INVALID_RESULTS',
      ],
      [
        'invalid errors',
        JSON.stringify(guardDogOutput({ errors: [] })),
        'INVALID_ERRORS',
      ],
      [
        'invalid risks',
        JSON.stringify(guardDogOutput({ risks: {} })),
        'INVALID_RISKS',
      ],
    ] as const)('rejects %s', (_name, stdout, kind) => {
      expectParserError(stdout, kind);
    });

    it.each([
      ['missing risk_score', undefined],
      ['non-object risk_score', []],
      [
        'invalid score',
        {
          score: '0',
          label: 'low',
          findings_count: 0,
          score_breakdown: {},
        },
      ],
      [
        'invalid label',
        {
          score: 0,
          label: 'critical',
          findings_count: 0,
          score_breakdown: {},
        },
      ],
      [
        'invalid findings_count',
        {
          score: 0,
          label: 'low',
          findings_count: -1,
          score_breakdown: {},
        },
      ],
      [
        'invalid score_breakdown',
        {
          score: 0,
          label: 'low',
          findings_count: 0,
          score_breakdown: [],
        },
      ],
    ])('rejects %s', (_name, riskScore) => {
      expectParserError(
        JSON.stringify(guardDogOutput({ risk_score: riskScore })),
        'INVALID_RISK_SCORE',
      );
    });
  });

  describe('security and retention boundaries', () => {
    it.each([
      ['/tmp/package/index.js:12'],
      ['C:\\scanner\\package\\index.js:12'],
      ['package/../secret.js:12'],
      ['package\\..\\secret.js:12'],
    ])('does not expose unsafe location %s as a common location', (location) => {
      const result = parse({ results: { 'threat-unsafe-path': [sourceFinding({ location })] } });

      expect(result.findings[0]).not.toHaveProperty('location');
      expect(result.findings[0]?.data.guarddog.rawResult.location).toBe(location);
    });

    it('does not synthesize identifies when GuardDog omitted it', () => {
      const result = parse({
        results: { 'capability-network-outbound': [sourceFinding()] },
      });

      expect(result.findings[0]?.data).not.toHaveProperty('identifies');
    });

    it('preserves an explicit identifies string without deriving it from the rule ID', () => {
      const result = parse({
        results: {
          'capability-network-outbound': [
            sourceFinding({ identifies: 'capability.network.outbound' }),
          ],
        },
      });

      expect(result.findings[0]?.data.identifies).toBe('capability.network.outbound');
    });

    it('does not return stdout or raw-result reference fields', () => {
      const stdout = JSON.stringify(guardDogOutput({
        results: { 'capability-network-outbound': [sourceFinding()] },
      }));
      const result = parseGuardDogOutput(stdout);
      const serializedResult = JSON.stringify(result);

      expect(result).not.toHaveProperty('stdout');
      expect(serializedResult).not.toContain('stdoutRef');
      expect(serializedResult).not.toContain('stderrRef');
      expect(serializedResult).not.toContain('rawResultRef');
      expect(serializedResult).not.toBe(stdout);
    });

    it('keeps the GuardDog score as assessment data without creating a decision', () => {
      const result = parse({
        risk_score: {
          score: 90,
          label: 'high_risk',
          findings_count: 2,
          score_breakdown: { correlated: 90 },
        },
      });

      expect(result.toolAssessment).toMatchObject({ score: 90, label: 'high_risk' });
      expect(result).not.toHaveProperty('decision');
      expect(result).not.toHaveProperty('policy');
    });
  });
});
