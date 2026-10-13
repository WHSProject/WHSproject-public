import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AnalyzerResult } from '../../domain/analysis.types';
import { DEFAULT_BUDGET } from './obfuscation.types';
import { buildCandidateContext, selectTargets } from './target-selector';

describe('selectTargets', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'scanner-obfuscation-selector-'));
    await mkdir(join(root, 'package'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('routes only contextual or structural candidates and ranks execution paths first', async () => {
    await writeFile(join(root, 'package', 'weak.js'), "const value = '\\u0068\\u0069';\n".repeat(2), 'utf8');
    await writeFile(join(root, 'package', 'base64.js'), "const config = JSON.parse(Buffer.from('eyJkZWJ1ZyI6ZmFsc2V9', 'base64').toString('utf8'));", 'utf8');
    await writeFile(join(root, 'package', 'parser.js'), 'let state=0; while (state < 2) { switch (state) { case 0: state=1; break; default: state=2; } }', 'utf8');
    await writeFile(join(root, 'package', 'bundle.js'), '(function(modules){function __webpack_require__(id){var module={exports:{}};modules[id](module,module.exports,__webpack_require__);return module.exports;}return __webpack_require__(0);}({0:function(module,exports){module.exports={value:1};}}));', 'utf8');
    await writeFile(join(root, 'package', 'entry.js'), "const value = '\\u0065\\u006e\\u0074\\u0072\\u0079';", 'utf8');
    await writeFile(join(root, 'package', 'dynamic.js'), 'eval(String.fromCharCode(99, 111, 110, 115, 111, 108, 101));', 'utf8');

    const result = await selectTargets(
      root,
      { main: 'package/entry.js' },
      DEFAULT_BUDGET,
    );

    const normalizedTargets = result.targets.map(({ path }) => path.replaceAll('\\', '/'));
    expect(normalizedTargets).toEqual(['package/entry.js', 'package/dynamic.js']);
    expect(result.verdicts.find(({ path }) => path.replaceAll('\\', '/') === 'package/weak.js')?.obfuscated).toBe(false);
    expect(result.verdicts.find(({ path }) => path.replaceAll('\\', '/') === 'package/base64.js')?.obfuscated).toBe(false);
    expect(result.verdicts.find(({ path }) => path.replaceAll('\\', '/') === 'package/parser.js')?.obfuscated).toBe(false);
    expect(result.verdicts.find(({ path }) => path.replaceAll('\\', '/') === 'package/bundle.js')?.obfuscated).toBe(false);
    expect(result.targets[0]?.candidateReasons).toContain('EXECUTION_PATH_WITH_OBFUSCATION_SIGNAL');
  });

  it('uses mapped Tier 1 capability findings only for the finding file', async () => {
    await writeFile(join(root, 'package', 'worker.js'), "const value = '\\u0068\\u0069';\n".repeat(2), 'utf8');
    await writeFile(join(root, 'package', 'other.js'), "const value = '\\u0068\\u0069';\n".repeat(2), 'utf8');
    const context = buildCandidateContext([
      {
        analyzer: 'guarddog',
        findings: [{
          type: 'CAPABILITY',
          ruleId: 'capability-process-spawn',
          location: { type: 'SOURCE_FILE', path: 'package/worker.js' },
        }],
      } as unknown as AnalyzerResult,
    ]);

    const result = await selectTargets(root, {}, DEFAULT_BUDGET, context);

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.path.replaceAll('\\', '/')).toBe('package/worker.js');
    expect(result.targets[0]?.candidateReasons).toContain('RISK_CAPABILITY_WITH_OBFUSCATION_SIGNAL');
    expect(result.verdicts.find(({ path }) => path.replaceAll('\\', '/') === 'package/other.js')?.obfuscated).toBe(false);
  });

  it('does not treat an unmapped or lifecycle-only finding as a risk capability', async () => {
    await writeFile(join(root, 'package', 'worker.js'), "const value = '\\u0068\\u0069';\n".repeat(2), 'utf8');
    const context = buildCandidateContext([
      {
        analyzer: 'guarddog',
        findings: [{ type: 'CAPABILITY', ruleId: 'capability-unused' }],
      } as unknown as AnalyzerResult,
      {
        analyzer: 'custom-rule',
        findings: [{ type: 'CAPABILITY_PATTERN', ruleId: 'custom.lifecycle-entry' }],
      } as unknown as AnalyzerResult,
    ]);

    const result = await selectTargets(root, {}, DEFAULT_BUDGET, context);

    expect(result.targets).toHaveLength(0);
    expect(result.verdicts[0]?.candidateReasons).toEqual([]);
  });
});
