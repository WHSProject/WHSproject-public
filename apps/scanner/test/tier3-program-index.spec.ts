import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PackageContextV0_3 } from '../src/llm-agent/artifact/agent-analysis-input.contract';
import { RuntimeArtifactResolver, originalArtifactDescriptor } from '../src/llm-agent/artifact/runtime-artifact-resolver';
import { BEHAVIOR_GROUPS, type BehaviorGroup, type ContextCode, type ContextWitnessPath } from '../src/llm-agent/context-check/context-check.contract';
import {
  ACTION_API_FAMILIES, ACTION_FAMILIES_BY_BEHAVIOR, BUILTIN_ACTION_FACTORIES, COMPOSITE_ACTION_STAGES, EXTERNAL_ACTION_APIS,
  EXTERNAL_ACTION_FACTORIES, isActionGlobal, isActionModule, isExternalAction,
} from '../src/llm-agent/context-check/program-index/action-apis';
import { buildActionPaths } from '../src/llm-agent/context-check/program-index/context-witness';
import { findInputWitness } from '../src/llm-agent/context-check/program-index/input-witness';
import { readLifecycleCommand } from '../src/llm-agent/context-check/program-index/lifecycle-command';
import { buildPackageProgramIndex, type PackageProgramIndex, type ProgramIndexInput } from '../src/llm-agent/context-check/program-index/program-index';
import { findTriggerWitness, findTriggerWitnesses } from '../src/llm-agent/context-check/program-index/trigger-witness';

/**
 * Synthetic packages written for these tests. Their code is harmless and is
 * only ever read and parsed: nothing here is required, imported or run.
 */
const HASH = 'c'.repeat(64);
const ARTIFACT = `artifact:${HASH}`;
type Files = Record<string, string>;
type Context = Pick<PackageContextV0_3, 'lifecycleScripts' | 'entryPoints'>;

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

const postinstall = (command = 'node index.js'): Context => ({ lifecycleScripts: [{ name: 'postinstall', command, location: null }], entryPoints: [] });
const main = (value = 'index.js'): Context => ({ lifecycleScripts: [], entryPoints: [{ type: 'MAIN', value, location: null }] });

async function writePackage(files: Files): Promise<RuntimeArtifactResolver> {
  const root = await mkdtemp(join(tmpdir(), 'program-index-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return new RuntimeArtifactResolver([{ descriptor: originalArtifactDescriptor(HASH), root }]);
}

async function indexOf(files: Files, packageContext: Context = postinstall(), options: Partial<ProgramIndexInput> = {}): Promise<PackageProgramIndex> {
  return buildPackageProgramIndex({ resolver: await writePackage(files), packageContext, maxFileSizeBytes: 1_048_576, ...options });
}

/** 1-based line of the first line of `file` that contains `marker`. */
function lineOf(files: Files, file: string, marker: string): number {
  const line = files[file]!.split('\n').findIndex((text) => text.includes(marker));
  if (line < 0) throw new Error(`Marker ${marker} is not in ${file}`);
  return line + 1;
}

async function trigger(files: Files, file: string, marker = 'FINDING', packageContext: Context = postinstall(), options: Partial<ProgramIndexInput> = {}) {
  const index = await indexOf(files, packageContext, options);
  const line = lineOf(files, file, marker);
  return { index, witness: findTriggerWitness(index, { artifactId: ARTIFACT, filePath: file }, { startLine: line, endLine: line }) };
}

async function inputOf(files: Files, file: string, marker = 'FINDING', packageContext: Context = postinstall()) {
  const index = await indexOf(files, packageContext);
  const line = lineOf(files, file, marker);
  return { index, witness: findInputWitness(index, { artifactId: ARTIFACT, filePath: file }, { startLine: line, endLine: line }) };
}

const sites = (witness: { statements: Array<{ filePath: string; startLine: number; endLine: number }> }): string[] => (
  witness.statements.map((item) => `${item.filePath}:${item.startLine}${item.endLine === item.startLine ? '' : `-${item.endLine}`}`)
);
const lines = (...parts: string[]): string => `${parts.join('\n')}\n`;

describe('program index: files and limits', () => {
  it('parses every supported source file once and leaves node_modules, links to nothing and other languages out', async () => {
    const files: Files = {
      'index.js': "require('./lib/a');\n", 'lib/a.cjs': 'module.exports = 1;\n', 'lib/b.mjs': 'export default 1;\n', 'lib/c.jsx': 'export const c = <a/>;\n',
      'lib/d.ts': 'export const d: number = 1;\n', 'lib/e.tsx': 'export const e = <b/>;\n', 'node_modules/dep/index.js': 'module.exports = 2;\n',
      'README.md': '# readme\n', 'data.json': '{}\n', 'script.py': 'print(1)\n', 'lib/d.d.ts': 'export declare const d: number;\n',
    };
    const index = await indexOf(files);
    expect(index.files.map((file) => file.filePath).sort()).toEqual(['index.js', 'lib/a.cjs', 'lib/b.mjs', 'lib/c.jsx', 'lib/d.ts', 'lib/e.tsx']);
    expect(index.files.every((file) => file.parsed)).toBe(true);
    expect(index.diagnostics).toMatchObject({ candidateFileCount: 6, parsedFileCount: 6, parseFailureCount: 0, excludedFiles: [], appliedLimits: [] });
    expect(index.diagnostics.totalSourceBytes).toBeGreaterThan(0);
    // The parsed file is shared: the single-file analysis is handed the same AST instead of parsing again.
    const facts = index.internal.facts.get(`${ARTIFACT}\u0000index.js`)!;
    expect(index.parseCache.get(facts.code)).toBe(facts.ast);
  });

  it('records a file that does not parse and keeps indexing the rest', async () => {
    const files: Files = { 'index.js': lines("const run = require('./run');", 'run(); // FINDING'), 'run.js': 'module.exports = function run() {};\n', 'broken.js': 'function ( {\n' };
    const { index, witness } = await trigger(files, 'index.js');
    expect(index.parseFailures).toEqual([{ artifactId: ARTIFACT, filePath: 'broken.js', reason: 'SYNTAX_ERROR' }]);
    expect(index.diagnostics).toMatchObject({ candidateFileCount: 3, parsedFileCount: 2, parseFailureCount: 1 });
    expect(index.limitations).toContain('PARSE_FAILURES');
    expect(witness.status).toBe('CONFIRMED');
    const broken = findTriggerWitness(index, { artifactId: ARTIFACT, filePath: 'broken.js' }, { startLine: 1, endLine: 1 });
    expect(broken).toMatchObject({ status: 'INCOMPLETE', incomplete: { reason: 'FILE_NOT_INDEXED' } });
  });

  it('stops at the file limit, the byte limit and the work limit without failing, and says what was left out', async () => {
    const files: Files = { 'a.js': 'const a = 1;\n', 'b.js': 'const b = 2;\n', 'c.js': 'const c = 3;\n' };
    const byFiles = await indexOf(files, postinstall(), { limits: { maxFiles: 2 } });
    expect(byFiles.files.map((file) => file.filePath)).toEqual(['a.js', 'b.js']);
    expect(byFiles.diagnostics.appliedLimits).toEqual(['FILE_LIMIT']);
    expect(byFiles.diagnostics.excludedFiles).toEqual([{ artifactId: ARTIFACT, filePath: 'c.js', reason: 'FILE_LIMIT' }]);

    const byBytes = await indexOf(files, postinstall(), { limits: { maxTotalSourceBytes: 20 } });
    expect(byBytes.diagnostics.appliedLimits).toEqual(['TOTAL_BYTES_LIMIT']);
    expect(byBytes.files).toHaveLength(1);
    expect(byBytes.diagnostics.excludedFiles.map((file) => file.reason)).toEqual(['TOTAL_BYTES_LIMIT', 'TOTAL_BYTES_LIMIT']);

    const byWork = await indexOf(files, postinstall(), { limits: { maxAstNodes: 8 } });
    expect(byWork.diagnostics.appliedLimits).toEqual(['WORK_LIMIT']);
    expect(byWork.diagnostics.excludedFiles.every((file) => file.reason === 'WORK_LIMIT')).toBe(true);
    expect(byWork.files.length).toBeLessThan(3);

    const oversized = await indexOf(files, postinstall(), { maxFileSizeBytes: 5 });
    expect(oversized.files).toEqual([]);
    expect(oversized.diagnostics.excludedFiles.every((file) => file.reason === 'FILE_REJECTED')).toBe(true);

    const timedOut = await indexOf(files, postinstall(), { limits: { buildTimeoutMs: -1 } });
    expect(timedOut.diagnostics.appliedLimits).toEqual(['TIMEOUT']);
    expect(timedOut.files).toEqual([]);
    expect(timedOut.diagnostics.excludedFiles.every((file) => file.reason === 'TIMEOUT')).toBe(true);
  });

  it('reads the files of the Findings and of what runs the package first, so a limit leaves those', async () => {
    const files: Files = { 'a.js': 'const a = 1;\n', 'b.js': 'const b = 2;\n', 'lib/target.js': 'act();\n', 'scripts/setup.js': "require('../lib/target');\n", 'z.js': 'const z = 3;\n' };
    const index = await indexOf(files, postinstall('node scripts/setup.js'), { limits: { maxFiles: 2 }, priorityPaths: ['lib/target.js'] });
    expect(index.files.map((file) => file.filePath)).toEqual(['lib/target.js', 'scripts/setup.js']);
    expect(index.diagnostics.excludedFiles.map((file) => `${file.filePath} ${file.reason}`)).toEqual(['a.js FILE_LIMIT', 'b.js FILE_LIMIT', 'z.js FILE_LIMIT']);
    const witness = findTriggerWitness(index, { artifactId: ARTIFACT, filePath: 'lib/target.js' }, { startLine: 1, endLine: 1 });
    expect(witness).toMatchObject({ status: 'CONFIRMED', root: { filePath: 'scripts/setup.js' } });
  });

  it('leaves out a hard-linked file, as the safe reader does everywhere else', async () => {
    const resolver = await writePackage({ 'index.js': "require('./linked');\n", 'real.js': 'act();\n' });
    const root = await resolver.resolveRoot(ARTIFACT);
    await link(join(root, 'real.js'), join(root, 'linked.js'));
    const index = await buildPackageProgramIndex({ resolver, packageContext: postinstall(), maxFileSizeBytes: 1_048_576 });
    expect(index.files.map((file) => file.filePath)).toEqual(['index.js']);
    expect(index.diagnostics.excludedFiles.map((file) => `${file.filePath} ${file.reason}`).sort()).toEqual(['linked.js FILE_REJECTED', 'real.js FILE_REJECTED']);
    expect(index.imports[0]).toMatchObject({ specifier: './linked', resolution: 'UNRESOLVED', unresolvedReason: 'TARGET_NOT_FOUND' });
  });

  it('passes an aborted scan on instead of recording a limitation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(indexOf({ 'index.js': 'run();\n' }, postinstall(), { signal: controller.signal })).rejects.toThrow();
  });
});

describe('program index: modules', () => {
  it('resolves CommonJS and ESM imports, an omitted extension, a directory index and a nested package.json', async () => {
    const files: Files = {
      'index.js': lines("const a = require('./lib/a');", "const { b } = require('./lib/b.js');", "require('./lib/dir');", "require('./lib/pkg');", "import('./lib/esm.mjs');"),
      'lib/a.js': 'module.exports = function a() {};\n', 'lib/b.js': 'exports.b = function b() {};\n', 'lib/dir/index.js': 'module.exports = {};\n',
      'lib/pkg/package.json': '{ "main": "./src/entry" }\n', 'lib/pkg/src/entry.js': 'module.exports = {};\n',
      'lib/esm.mjs': lines("import d, { named as renamed } from './named.mjs';", "export * from './named.mjs';", 'export default d;'),
      'lib/named.mjs': lines('export const named = 1;', 'export default function d() {}'),
    };
    const index = await indexOf(files);
    const resolved = index.imports.filter((edge) => edge.resolution === 'RESOLVED').map((edge) => `${edge.from.filePath} ${edge.kind} ${edge.specifier} -> ${edge.to!.filePath}`);
    expect(resolved).toEqual([
      'index.js REQUIRE ./lib/a -> lib/a.js', 'index.js REQUIRE ./lib/b.js -> lib/b.js', 'index.js REQUIRE ./lib/dir -> lib/dir/index.js',
      'index.js REQUIRE ./lib/pkg -> lib/pkg/src/entry.js', 'index.js DYNAMIC_IMPORT ./lib/esm.mjs -> lib/esm.mjs',
      'lib/esm.mjs IMPORT ./named.mjs -> lib/named.mjs', 'lib/esm.mjs REEXPORT ./named.mjs -> lib/named.mjs',
    ]);
    expect(index.reverseImports.get(`${ARTIFACT}\u0000lib/named.mjs`)!.map((edge) => edge.from.filePath)).toEqual(['lib/esm.mjs', 'lib/esm.mjs']);
    expect(index.modules.get(`${ARTIFACT}\u0000index.js`)!.imports.map((file) => file.filePath)).toEqual(['lib/a.js', 'lib/b.js', 'lib/dir/index.js', 'lib/pkg/src/entry.js', 'lib/esm.mjs']);
    expect(index.modules.get(`${ARTIFACT}\u0000lib/a.js`)!.importedBy.map((file) => file.filePath)).toEqual(['index.js']);
    expect(index.exports.filter((item) => item.filePath === 'lib/named.mjs').map((item) => item.name).sort()).toEqual(['default', 'named']);
  });

  it('records a computed or missing import as unresolved and never points it at a file', async () => {
    const files: Files = {
      'index.js': lines("const name = './lib/' + process.argv[2];", 'require(name);', 'import(`./lib/${name}`);', "require('./missing');", "require('../outside');", "require('fs');", "require('./data.json');"),
      'lib/a.js': 'module.exports = {};\n', 'data.json': '{}\n',
    };
    const index = await indexOf(files);
    expect(index.imports.map((edge) => `${edge.specifier} ${edge.resolution} ${edge.unresolvedReason ?? ''}`.trim())).toEqual([
      'null UNRESOLVED COMPUTED_SPECIFIER', 'null UNRESOLVED COMPUTED_SPECIFIER', './missing UNRESOLVED TARGET_NOT_FOUND', '../outside UNRESOLVED OUTSIDE_ARTIFACT',
      'fs EXTERNAL', './data.json EXTERNAL',
    ]);
    expect(index.imports.every((edge) => edge.resolution === 'RESOLVED' || edge.to === undefined)).toBe(true);
    expect(index.diagnostics.unresolvedModuleEdgeCount).toBe(4);
    expect(index.limitations).toContain('UNRESOLVED_MODULE_EDGES');
    // Nothing loads the file behind the computed path, so its path starts at the file itself.
    const witness = findTriggerWitness(index, { artifactId: ARTIFACT, filePath: 'lib/a.js' }, { startLine: 1, endLine: 1 });
    expect(witness).toMatchObject({ status: 'CONFIRMED', steps: [], root: { kind: 'UNREFERENCED', filePath: 'lib/a.js' } });
  });
});

describe('program index: TRIGGER witness', () => {
  it('follows a direct call in the same file', async () => {
    const files: Files = { 'index.js': lines('function send() {', '  connect(); // FINDING', '}', 'send();') };
    const { witness } = await trigger(files, 'index.js');
    expect(witness).toMatchObject({ status: 'CONFIRMED', evidence: 'CONFIRMED', asyncBoundary: false, root: { kind: 'LIFECYCLE', name: 'postinstall', filePath: 'index.js' } });
    expect(witness.steps.map((step) => `${step.kind} ${step.calleeSymbol} ${step.site.filePath}:${step.site.startLine}`)).toEqual(['CALL send index.js:4']);
    expect(sites(witness)).toEqual(['index.js:4', 'index.js:2']);
  });

  it('follows a call across CommonJS files with the require and export statements on the path', async () => {
    const files: Files = {
      'index.js': lines("const { install } = require('./install');", 'install();'),
      'install.js': lines('function run() {', '  exec(command); // FINDING', '}', 'function install() {', '  run();', '}', 'module.exports = { install };'),
    };
    const { witness } = await trigger(files, 'install.js');
    expect(witness.status).toBe('CONFIRMED');
    expect(witness.steps.map((step) => `${step.kind} ${step.calleeSymbol} ${step.site.filePath}:${step.site.startLine}`)).toEqual(['CALL install index.js:2', 'CALL run install.js:5']);
    // The call site, the require that names the function, the export that provides it, the inner call, the Finding.
    expect(sites(witness)).toEqual(['index.js:2', 'index.js:1', 'install.js:7', 'install.js:5', 'install.js:2']);
  });

  it('follows a call across ESM files through default, named and renamed imports', async () => {
    const files: Files = {
      'index.mjs': lines("import start, { helper as renamed } from './lib.mjs';", 'start();', 'renamed();'),
      'lib.mjs': lines('export default function start() {', '  one(); // DEFAULT', '}', 'function inner() {', '  two(); // NAMED', '}', 'export { inner as helper };'),
    };
    const context = postinstall('node index.mjs');
    const byDefault = (await trigger(files, 'lib.mjs', 'DEFAULT', context)).witness;
    expect(byDefault.status).toBe('CONFIRMED');
    expect(sites(byDefault)).toEqual(['index.mjs:2', 'index.mjs:1', 'lib.mjs:1', 'lib.mjs:2']);
    const byName = (await trigger(files, 'lib.mjs', 'NAMED', context)).witness;
    expect(byName.status).toBe('CONFIRMED');
    expect(byName.steps.map((step) => step.calleeSymbol)).toEqual(['inner']);
    expect(sites(byName)).toEqual(['index.mjs:3', 'index.mjs:1', 'lib.mjs:7', 'lib.mjs:5']);
  });

  it('follows a re-export through a barrel file', async () => {
    const files: Files = {
      'index.mjs': lines("import { run } from './lib/index.mjs';", 'run();'),
      'lib/index.mjs': lines("export { run } from './run.mjs';", "export * from './other.mjs';"),
      'lib/run.mjs': lines('export function run() {', '  act(); // FINDING', '}'), 'lib/other.mjs': 'export const other = 1;\n',
    };
    const { witness } = await trigger(files, 'lib/run.mjs', 'FINDING', postinstall('node index.mjs'));
    expect(witness.status).toBe('CONFIRMED');
    expect(sites(witness)).toEqual(['index.mjs:2', 'index.mjs:1', 'lib/index.mjs:1', 'lib/run.mjs:1', 'lib/run.mjs:2']);
  });

  it('resolves an omitted extension, a directory index and a file that only runs at its top level', async () => {
    const files: Files = { 'index.js': lines("require('./lib');"), 'lib/index.js': lines("require('./worker');"), 'lib/worker.js': lines('spawn(command); // FINDING') };
    const { witness } = await trigger(files, 'lib/worker.js');
    expect(witness.status).toBe('CONFIRMED');
    expect(witness.steps.map((step) => `${step.kind} ${step.site.filePath}:${step.site.startLine}`)).toEqual(['MODULE_LOAD index.js:1', 'MODULE_LOAD lib/index.js:1']);
  });

  it('ends on a circular import instead of looping, and still finds the path through it', async () => {
    const files: Files = {
      'index.js': lines("require('./a');"),
      'a.js': lines("const b = require('./b');", 'exports.fromA = function fromA() {};', 'b.run();'),
      'b.js': lines("const a = require('./a');", 'exports.run = function run() {', '  act(); // FINDING', '};'),
    };
    const { witness } = await trigger(files, 'b.js');
    expect(witness.status).toBe('CONFIRMED');
    expect(witness.steps.map((step) => `${step.kind} ${step.site.filePath}:${step.site.startLine}`)).toEqual(['MODULE_LOAD index.js:1', 'CALL a.js:3']);
  });

  it('follows a simple alias, an object method and a class method', async () => {
    const files: Files = {
      'index.js': lines(
        'function real() {', '  one(); // ALIAS', '}', 'const alias = real;', 'alias();',
        'const tools = { run() {', '  two(); // OBJECT', '} };', 'tools.run();',
        'class Job {', '  start() {', '    three(); // CLASS', '  }', '  static make() {', '    four(); // STATIC', '  }', '}', 'const job = new Job();', 'job.start();', 'Job.make();',
      ),
    };
    for (const [marker, callee, site] of [['ALIAS', 'real', 5], ['OBJECT', 'run', 9], ['CLASS', 'Job.start', 19], ['STATIC', 'Job.make', 20]] as const) {
      const { witness } = await trigger(files, 'index.js', marker);
      expect(witness.status).toBe('CONFIRMED');
      expect(witness.steps.map((step) => `${step.calleeSymbol} ${step.site.startLine}`)).toEqual([`${callee} ${site}`]);
    }
    // The alias declaration is part of what ties the call to the function.
    expect(sites((await trigger(files, 'index.js', 'ALIAS')).witness)).toEqual(['index.js:5', 'index.js:4', 'index.js:2']);
  });

  it('follows `.call` and `.apply` to their static target and starts a function reached only dynamically at itself', async () => {
    const files: Files = {
      'index.js': lines('function real() {', '  one(); // CALL', '}', 'real.call(null);', 'function other() {', '  two(); // DYNAMIC', '}', 'const table = { other };', 'table[process.argv[2]]();'),
    };
    expect((await trigger(files, 'index.js', 'CALL')).witness.status).toBe('CONFIRMED');
    const dynamic = (await trigger(files, 'index.js', 'DYNAMIC')).witness;
    expect(dynamic).toMatchObject({ status: 'CONFIRMED', steps: [], root: { kind: 'UNREFERENCED', name: 'other' } });
  });

  it('starts an exported function that nothing in the package calls at the export', async () => {
    const files: Files = { 'index.js': lines("require('./lib');"), 'lib.js': lines('exports.later = function later() {', '  act(); // FINDING', '};') };
    const { witness } = await trigger(files, 'lib.js');
    expect(witness).toMatchObject({ status: 'CONFIRMED', evidence: 'CONFIRMED', steps: [], root: { kind: 'EXPORTED_API', name: 'later', filePath: 'lib.js' } });
  });

  it('follows lifecycle → entry → several files → Finding and keeps every statement of the path', async () => {
    const files: Files = {
      'scripts/setup.js': lines("const { boot } = require('../src');", 'boot();'),
      'src/index.js': lines("const runner = require('./runner');", 'exports.boot = function boot() {', '  runner.start();', '};'),
      'src/runner.js': lines("const { send } = require('./net/send');", 'function start() {', '  send(collect());', '}', 'module.exports = { start };'),
      'src/net/send.js': lines('exports.send = function send(payload) {', '  request(payload); // FINDING', '};'),
    };
    const { witness } = await trigger(files, 'src/net/send.js', 'FINDING', postinstall('node scripts/setup.js'));
    expect(witness).toMatchObject({ status: 'CONFIRMED', root: { kind: 'LIFECYCLE', name: 'postinstall', filePath: 'scripts/setup.js' } });
    expect(witness.steps.map((step) => `${step.kind} ${step.calleeSymbol} ${step.site.filePath}:${step.site.startLine}`)).toEqual([
      'CALL boot scripts/setup.js:2', 'CALL start src/index.js:3', 'CALL send src/runner.js:3',
    ]);
    expect(sites(witness)).toEqual([
      'scripts/setup.js:2', 'scripts/setup.js:1', 'src/index.js:2', 'src/index.js:3', 'src/index.js:1', 'src/runner.js:5', 'src/runner.js:3', 'src/runner.js:1', 'src/net/send.js:1', 'src/net/send.js:2',
    ]);
    // The same path from an entry point is a path, but not one a lifecycle script runs.
    const fromMain = (await trigger(files, 'src/net/send.js', 'FINDING', main('scripts/setup.js'))).witness;
    expect(fromMain).toMatchObject({ status: 'CONFIRMED', root: { kind: 'ENTRY_POINT', name: 'MAIN' } });
  });

  it('follows TypeScript sources, including a sibling imported under its emitted `.js` name', async () => {
    const files: Files = {
      'index.ts': lines("import { run } from './worker.js';", 'const count: number = 1;', 'run(count as number);'),
      'worker.ts': lines('export function run(times: number): void {', '  act(times); // FINDING', '}'),
    };
    const { witness, index } = await trigger(files, 'worker.ts', 'FINDING', postinstall('node index.ts'));
    expect(index.parseFailures).toEqual([]);
    expect(witness.status).toBe('CONFIRMED');
    expect(sites(witness)).toEqual(['index.ts:3', 'index.ts:1', 'worker.ts:1', 'worker.ts:2']);
  });

  it('takes a literal dynamic import as an asynchronous load and does not follow a computed one', async () => {
    const literal: Files = { 'index.js': lines("import('./later.js');"), 'later.js': lines('act(); // FINDING') };
    const loaded = (await trigger(literal, 'later.js')).witness;
    expect(loaded).toMatchObject({ status: 'CONFIRMED', evidence: 'CONFIRMED_ASYNC', asyncBoundary: true });
    expect(loaded.steps.map((step) => `${step.kind} ${step.evidence}`)).toEqual(['MODULE_LOAD CONFIRMED_ASYNC']);
    const stopped = (await trigger({ ...literal, 'index.js': lines("import('./later.js');", 'process.exit(0);') }, 'later.js')).witness;
    expect(stopped).toMatchObject({ status: 'CONFIRMED', evidence: 'PROBABLE', root: { kind: 'LIFECYCLE' } });
    const computed = (await trigger({ ...literal, 'index.js': lines('import(`./${name}.js`);', 'require(pick());') }, 'later.js')).witness;
    expect(computed).toMatchObject({ status: 'CONFIRMED', steps: [], root: { kind: 'UNREFERENCED', filePath: 'later.js' } });
  });

  it('reaches a restored file through what loads the original it was restored from', async () => {
    const original = await mkdtemp(join(tmpdir(), 'program-index-original-'));
    const restored = await mkdtemp(join(tmpdir(), 'program-index-restored-'));
    roots.push(original, restored);
    await writeFile(join(original, 'index.js'), lines("require('./payload');"));
    await writeFile(join(original, 'payload.js'), lines('var _0x1 = [];', 'run(_0x1);'));
    await writeFile(join(restored, 'payload.js'), lines("const { exec } = require('child_process');", 'exec(command); // FINDING'));
    const RESTORED = `${ARTIFACT}:deobfuscated`;
    const resolver = new RuntimeArtifactResolver([
      { descriptor: originalArtifactDescriptor(HASH), root: original },
      { descriptor: { artifactId: RESTORED, representation: 'DEOBFUSCATED', analysisPass: 'TIER2', contentSha256: 'd'.repeat(64), derivedFromArtifactId: ARTIFACT, lineageStatus: 'UNMAPPED', producer: 'test' }, root: restored },
    ]);
    const index = await buildPackageProgramIndex({ resolver, packageContext: postinstall(), maxFileSizeBytes: 1_048_576 });
    expect(index.files.map((file) => `${file.artifactId === ARTIFACT ? 'ORIGINAL' : 'RESTORED'} ${file.filePath}`)).toEqual(['ORIGINAL index.js', 'ORIGINAL payload.js', 'RESTORED payload.js']);
    const witness = findTriggerWitness(index, { artifactId: RESTORED, filePath: 'payload.js' }, { startLine: 2, endLine: 2 });
    expect(witness).toMatchObject({ status: 'CONFIRMED', root: { kind: 'LIFECYCLE', filePath: 'index.js' } });
    expect(witness.statements.map((item) => `${item.artifactId === ARTIFACT ? 'ORIGINAL' : 'RESTORED'} ${item.filePath}:${item.startLine}`)).toEqual(['ORIGINAL index.js:1', 'RESTORED payload.js:2']);
  });

  it('prefers the path whose weakest step is best established, then the shortest', async () => {
    const files: Files = {
      'index.js': lines('function act() {', '  go(); // FINDING', '}', 'setTimeout(act, 10);', 'function viaCall() {', '  act();', '}', 'viaCall();'),
    };
    const { witness } = await trigger(files, 'index.js');
    expect(witness.status).toBe('CONFIRMED');
    expect(witness.steps.map((step) => step.calleeSymbol)).toEqual(['viaCall', 'act']);
  });

  /** `f0` holds the Finding and each `f<n>` calls `f<n-1>`; the top level calls the last one, so the path has `calls` steps. */
  const callChain = (calls: number, probableAt?: number): Files => {
    const chain = ['function f0() {', '  act(); // FINDING', '}'];
    for (let depth = 1; depth < calls; depth += 1) {
      // A name that is assigned again may hold another function by the time it is called: a probable step.
      if (depth === probableAt) chain.push(`let alias${depth} = f${depth - 1};`, `alias${depth} = alias${depth};`, `function f${depth}() {`, `  alias${depth}();`, '}');
      else chain.push(`function f${depth}() {`, `  f${depth - 1}();`, '}');
    }
    chain.push(`f${calls - 1}();`);
    return { 'index.js': lines(...chain) };
  };

  it('follows a path for sixteen steps, with or without a probable step, and starts a longer one where the search stops', async () => {
    const full = (await trigger(callChain(16), 'index.js')).witness;
    expect(full).toMatchObject({ status: 'CONFIRMED', exploredDepth: 16, probableEdgeCount: 0, limitations: [], root: { kind: 'LIFECYCLE' } });
    expect(full.steps).toHaveLength(16);
    const longer = (await trigger(callChain(17), 'index.js')).witness;
    expect(longer).toMatchObject({ status: 'CONFIRMED', root: { kind: 'UNREFERENCED' } });
    expect(longer.steps).toHaveLength(16);
    expect(longer.limitations).toEqual(['DEPTH_LIMIT']);

    const probable = (await trigger(callChain(16, 2), 'index.js')).witness;
    expect(probable).toMatchObject({ status: 'CONFIRMED', evidence: 'PROBABLE', exploredDepth: 16, probableEdgeCount: 1, limitations: [], root: { kind: 'LIFECYCLE' } });
  });

  it('stops at the visit limit, the candidate limit and the time limit and says so', async () => {
    const files = callChain(6);
    const few = (await trigger(files, 'index.js', 'FINDING', postinstall(), { limits: { maxVisitedSymbols: 2 } })).witness;
    expect(few.status).toBe('INCOMPLETE');
    expect(few.limitations).toContain('VISITED_SYMBOL_LIMIT');
    const late = (await trigger(files, 'index.js', 'FINDING', postinstall(), { limits: { witnessSearchTimeoutMs: -1 } })).witness;
    expect(late.status).toBe('INCOMPLETE');
    expect(late.limitations).toEqual(['SEARCH_TIMEOUT']);
    // Three ways from the top level to the Finding; with room for one candidate the search ends at the first.
    const several: Files = { 'index.js': lines('function act() {', '  go(); // FINDING', '}', 'function a() {', '  act();', '}', 'function b() {', '  a();', '}', 'act();', 'a();', 'b();') };
    const one = (await trigger(several, 'index.js', 'FINDING', postinstall(), { limits: { maxWitnessPaths: 1 } })).witness;
    expect(one).toMatchObject({ status: 'CONFIRMED', exploredDepth: 1 });
    expect(one.steps.map((step) => step.site.startLine)).toEqual([10]);
  });

  it('never enters a symbol twice on one path', async () => {
    const files: Files = {
      'index.js': lines('function ping(times) {', '  act(); // FINDING', '  pong(times);', '}', 'function pong(times) {', '  if (times > 0) ping(times - 1);', '}', 'ping(3);'),
    };
    const { witness } = await trigger(files, 'index.js');
    expect(witness.status).toBe('CONFIRMED');
    expect(witness.steps.map((step) => `${step.calleeSymbol} ${step.site.startLine}`)).toEqual(['ping 8']);
    // Without the call from the top level the two functions only call each other: the path starts at them, and there is no loop.
    const closed = (await trigger({ 'index.js': files['index.js']!.replace('ping(3);\n', '') }, 'index.js')).witness;
    expect(closed).toMatchObject({ status: 'CONFIRMED', root: { kind: 'UNREFERENCED' } });
    expect(closed.exploredDepth).toBeLessThanOrEqual(2);
  });

  it('prefers a longer path of confirmed steps to a shorter path with a probable step, and follows any number of probable steps', async () => {
    const files: Files = {
      'index.js': lines(
        'function act() {', '  go(); // FINDING', '}',
        'let maybe = act;', 'maybe = maybe;', 'maybe();',
        'function one() {', '  act();', '}', 'function two() {', '  one();', '}', 'two();',
      ),
    };
    const { witness } = await trigger(files, 'index.js');
    expect(witness).toMatchObject({ status: 'CONFIRMED', probableEdgeCount: 0 });
    expect(witness.steps.map((step) => step.calleeSymbol)).toEqual(['two', 'one', 'act']);
    const probableOnly = (await trigger({ 'index.js': files['index.js']!.replace('two();\n', '') }, 'index.js')).witness;
    expect(probableOnly).toMatchObject({ status: 'CONFIRMED', evidence: 'PROBABLE', probableEdgeCount: 1 });
    expect(probableOnly.steps.map((step) => `${step.calleeSymbol} ${step.site.startLine} ${step.evidence}`)).toEqual(['act 6 PROBABLE']);

    const twice: Files = {
      'index.js': lines('function act() {', '  go(); // FINDING', '}', 'let first = act;', 'first = first;', 'function mid() {', '  first();', '}', 'let second = mid;', 'second = second;', 'second();'),
    };
    const double = (await trigger(twice, 'index.js')).witness;
    expect(double).toMatchObject({ status: 'CONFIRMED', evidence: 'PROBABLE', probableEdgeCount: 2, limitations: [] });
  });
});

describe('program index: callbacks', () => {
  const callbackOf = async (files: Files, marker = 'FINDING') => {
    const { witness } = await trigger(files, 'index.js', marker);
    const step = witness.steps.find((item) => item.kind === 'CALLBACK');
    return { witness, step, text: `${witness.status} ${step?.callbackKind} ${step?.evidence}` };
  };

  it('confirms a synchronous callback on an array, an immediately invoked function and a function that calls its parameter', async () => {
    expect((await callbackOf({ 'index.js': lines("['a', 'b'].forEach((item) => {", '  use(item); // FINDING', '});') })).text).toBe('CONFIRMED SYNCHRONOUS_CALLBACK CONFIRMED');
    expect((await callbackOf({ 'index.js': lines('Object.keys(process.env).map(function (key) {', '  use(key); // FINDING', '});') })).text).toBe('CONFIRMED SYNCHRONOUS_CALLBACK CONFIRMED');
    expect((await callbackOf({ 'index.js': lines('function each(list, visit) {', '  for (const item of list) visit(item);', '}', 'each(names, (name) => {', '  use(name); // FINDING', '});') })).text)
      .toBe('CONFIRMED SYNCHRONOUS_CALLBACK CONFIRMED');
    expect((await callbackOf({ 'index.js': lines('new Promise((resolve) => {', '  use(resolve); // FINDING', '});') })).text).toBe('CONFIRMED SYNCHRONOUS_CALLBACK CONFIRMED');
    const immediate = (await trigger({ 'index.js': lines('(function () {', '  use(1); // FINDING', '})();') }, 'index.js')).witness;
    expect(immediate.status).toBe('CONFIRMED');
    expect(immediate.steps.map((step) => `${step.kind} ${step.callbackKind}`)).toEqual(['IMMEDIATE_CALL IMMEDIATE_INVOCATION']);
  });

  it('follows a synchronous-looking callback on an unknown receiver as a probable step', async () => {
    const found = await callbackOf({ 'index.js': lines('items.forEach((item) => {', '  use(item); // FINDING', '});') });
    expect(found.text).toBe('CONFIRMED SYNCHRONOUS_CALLBACK PROBABLE');
    expect(found.step?.unresolvedReason).toBe('RECEIVER_NOT_STATIC_ARRAY');
  });

  it('confirms a locally emitted event only when the listener is added before the emit in the same body', async () => {
    const emitter = ["const { EventEmitter } = require('events');", 'const bus = new EventEmitter();'];
    const ordered = await callbackOf({ 'index.js': lines(...emitter, "bus.on('go', () => {", '  use(1); // FINDING', '});', "bus.emit('go');") });
    expect(ordered.text).toBe('CONFIRMED LOCALLY_EMITTED_EVENT CONFIRMED');
    expect(sites(ordered.witness)).toEqual(['index.js:6', 'index.js:3', 'index.js:4']);
    const late = await callbackOf({ 'index.js': lines(...emitter, "bus.emit('go');", "bus.on('go', () => {", '  use(1); // FINDING', '});') });
    expect(late.text).toBe('CONFIRMED LOCALLY_EMITTED_EVENT PROBABLE');
    expect(late.step?.unresolvedReason).toBe('EMIT_ORDER_NOT_ESTABLISHED');
    const other = await callbackOf({ 'index.js': lines(...emitter, "bus.on('go', () => {", '  use(1); // FINDING', '});', "bus.emit('stop');") });
    // A listener nothing in the code emits to is a registered callback: it runs when the event arrives.
    expect(other.text).toBe('CONFIRMED EXTERNAL_EVENT_CALLBACK CONFIRMED_ASYNC');
  });

  it('takes a callback handed to an outside event, a timer or an unknown function as run once that fires', async () => {
    const cases: Array<[string[], string, string]> = [
      [["process.on('exit', () => {", '  use(1); // FINDING', '});'], 'EXTERNAL_EVENT_CALLBACK', 'EXTERNAL_EVENT'],
      [["const https = require('https');", 'https.get(url, (response) => {', '  use(response); // FINDING', '});'], 'EXTERNAL_EVENT_CALLBACK', 'EXTERNAL_API'],
      [['setTimeout(() => {', '  use(1); // FINDING', '}, 1000);'], 'TIMER_CALLBACK', 'TIMER'],
      [['setInterval(function tick() {', '  use(1); // FINDING', '}, 1000);'], 'TIMER_CALLBACK', 'TIMER'],
      [['setImmediate(() => {', '  use(1); // FINDING', '});'], 'TIMER_CALLBACK', 'TIMER'],
      [['register(() => {', '  use(1); // FINDING', '});'], 'UNKNOWN_CALLBACK', 'UNKNOWN_CALLEE'],
      [['function keep(fn) {', '  queue.push(fn);', '}', 'keep(() => {', '  use(1); // FINDING', '});'], 'UNKNOWN_CALLBACK', 'CALLBACK_PASSED_ON'],
    ];
    for (const [source, kind, reason] of cases) {
      const found = await callbackOf({ 'index.js': lines(...source) });
      expect(found.text).toBe(`CONFIRMED ${kind} CONFIRMED_ASYNC`);
      expect(found.step).toMatchObject({ basis: `REGISTERED_CALLBACK:${reason}`, asyncBoundary: true });
      expect(found.witness).toMatchObject({ asyncBoundary: true, evidence: 'CONFIRMED_ASYNC', root: { kind: 'LIFECYCLE' }, limitations: [] });
      expect(found.witness.steps).toHaveLength(1);
    }
    // A run that is ended right after the registration may never get to the callback.
    const stopped = await callbackOf({ 'index.js': lines('setTimeout(() => {', '  use(1); // FINDING', '}, 1000);', 'process.exit(0);') });
    expect(stopped.text).toBe('CONFIRMED TIMER_CALLBACK PROBABLE');
    expect(stopped.step?.unresolvedReason).toBe('TERMINATION_AFTER_REGISTRATION');
  });

  describe('Promise.resolve().then()', () => {
    const then = (...before: string[]) => [...before, 'Promise.resolve(seed).then((value) => {', '  use(value); // FINDING', '});'];

    it('is confirmed as an asynchronous step when the source leaves no doubt', async () => {
      const found = await callbackOf({ 'index.js': lines(...then()) });
      expect(found.text).toBe('CONFIRMED PROMISE_MICROTASK CONFIRMED_ASYNC');
      expect(found.witness).toMatchObject({ evidence: 'CONFIRMED_ASYNC', asyncBoundary: true });
      const named = await callbackOf({ 'index.js': lines('function later(value) {', '  use(value); // FINDING', '}', 'Promise.resolve(seed).then(later);') });
      expect(named.text).toBe('CONFIRMED PROMISE_MICROTASK CONFIRMED_ASYNC');
    });

    it.each([
      ['a shadowed Promise', ['const Promise = require("./promise");', 'Promise.resolve(seed).then((value) => {', '  use(value); // FINDING', '});'], 'PROMISE_SHADOWED'],
      ['a receiver that is not Promise.resolve()', ['fetchIt().then((value) => {', '  use(value); // FINDING', '});'], 'RECEIVER_NOT_PROMISE_RESOLVE'],
      ['a chained then', ['Promise.resolve(seed).then(first).then((value) => {', '  use(value); // FINDING', '});'], 'RECEIVER_NOT_PROMISE_RESOLVE'],
      ['a rejection handler', ['Promise.resolve(seed).then(first, (value) => {', '  use(value); // FINDING', '});'], 'REJECTION_HANDLER'],
      ['a catch handler', ['Promise.resolve(seed).catch((value) => {', '  use(value); // FINDING', '});'], 'NOT_A_THEN_CALLBACK'],
      ['a process exit after the registration', [...then(), 'process.exit(0);'], 'TERMINATION_AFTER_REGISTRATION'],
      ['a throw after the registration', [...then(), "throw new Error('stop');"], 'TERMINATION_AFTER_REGISTRATION'],
      ['a redefined then', ['Promise.prototype.then = function () {};', ...then()], 'PROMISE_REDEFINED'],
      ['a replaced global Promise', ['globalThis.Promise = Fake;', ...then()], 'PROMISE_REDEFINED'],
    ])('stays probable with %s', async (_name, source, reason) => {
      const found = await callbackOf({ 'index.js': lines(...source), 'promise.js': 'module.exports = {};\n' });
      expect(found.text).toBe('CONFIRMED PROMISE_MICROTASK PROBABLE');
      expect(found.step?.unresolvedReason).toBe(reason);
    });

    it('stays probable when another file of the package redefines then, or a caller exits right after the call', async () => {
      const elsewhere = await callbackOf({ 'index.js': lines("require('./patch');", ...then()), 'patch.js': "Object.defineProperty(Promise.prototype, 'then', { value() {} });\n" });
      expect(elsewhere.text).toBe('CONFIRMED PROMISE_MICROTASK PROBABLE');
      const exits = await callbackOf({ 'index.js': lines('function start() {', ...then().map((line) => `  ${line}`), '}', 'start();', 'process.exit(0);') });
      expect(exits.text).toBe('CONFIRMED PROMISE_MICROTASK PROBABLE');
      expect(exits.step?.unresolvedReason).toBe('TERMINATION_AFTER_REGISTRATION');
    });
  });

  it('runs a `require.main === module` branch only for the file a lifecycle script runs itself', async () => {
    const files: Files = { 'index.js': lines("require('./cli');"), 'cli.js': lines('function run() {', '  act(); // FINDING', '}', 'if (require.main === module) {', '  run();', '}') };
    const direct = (await trigger(files, 'cli.js', 'FINDING', postinstall('node cli.js'))).witness;
    expect(direct.status).toBe('CONFIRMED');
    expect(direct.steps[0]!.within).toMatchObject({ kind: 'RUN_DIRECTLY', startLine: 4, endLine: 6 });
    const required = (await trigger(files, 'cli.js')).witness;
    expect(required).toMatchObject({ status: 'INCOMPLETE', incomplete: { reason: 'UNRESOLVED_EDGE' } });
    expect(required.steps.at(-1)).toMatchObject({ evidence: 'UNRESOLVED', unresolvedReason: 'RUN_DIRECTLY_CONDITION_NOT_MET' });
  });
});

describe('program index: export resolution', () => {
  it('ends on exports that lead back to each other instead of looping', async () => {
    const files: Files = {
      'index.js': lines("const lib = require('./lib');", 'lib.a();', 'lib.real();'),
      'lib.js': lines('exports.a = exports.b;', 'exports.b = exports.a;', 'exports.real = function real() {', '  act(); // FINDING', '};'),
    };
    const { witness, index } = await trigger(files, 'lib.js');
    expect(index.limitations).not.toContain('CALL_RESOLUTION_FAILED');
    expect(witness.status).toBe('CONFIRMED');
    expect(index.calls.find((edge) => edge.calleeName === 'lib.a')).toMatchObject({ evidence: 'UNRESOLVED', unresolvedReason: 'EXPORT_CYCLE' });
  });
});

describe('program index: INPUT witness', () => {
  const flow = (witness: { edges: Array<{ kind: string; from?: { filePath: string; startLine: number }; to: { filePath: string; startLine: number }; name?: string }> }): string[] => (
    witness.edges.map((edge) => `${edge.kind} ${edge.name ?? ''} ${edge.from ? `${edge.from.filePath}:${edge.from.startLine}` : '-'} -> ${edge.to.filePath}:${edge.to.startLine}`)
  );

  it('follows a direct assignment, an alias and a later assignment', async () => {
    const files: Files = { 'index.js': lines('let token = process.env.TOKEN;', 'const copy = token;', "token = token + '!';", 'send(copy); // FINDING') };
    const { witness } = await inputOf(files, 'index.js');
    expect(witness.status).toBe('COMPLETE');
    expect(flow(witness)).toEqual(['ALIAS copy index.js:2 -> index.js:4', 'INITIALIZER token index.js:1 -> index.js:2', 'ASSIGNMENT token index.js:3 -> index.js:2']);
    expect(sites(witness)).toEqual(['index.js:2', 'index.js:1', 'index.js:3']);
  });

  it('follows an argument into a parameter and a return value back out', async () => {
    const files: Files = {
      'index.js': lines('function collect() {', '  return process.env;', '}', 'function send(payload) {', '  post(payload); // FINDING', '}', 'send(collect());'),
    };
    const { witness, index } = await inputOf(files, 'index.js');
    expect(witness.status).toBe('COMPLETE');
    expect(flow(witness)).toEqual(['ARGUMENT_TO_PARAMETER payload index.js:7 -> index.js:4', 'RETURN collect index.js:2 -> index.js:7']);
    // The declaration of the function entered, the call site, and the short function whose return is passed in, shown whole.
    expect(sites(witness)).toEqual(['index.js:4', 'index.js:7', 'index.js:1-3']);
    expect(index.dataFlow).toHaveLength(2);
  });

  it('follows destructuring, a static property and a template string', async () => {
    const files: Files = {
      'index.js': lines("const config = { host: 'example.test', port: 443 };", 'const { host } = config;', 'config.path = process.argv[2];', 'const url = `https://${host}${config.path}`;', 'get(url); // FINDING'),
    };
    const { witness } = await inputOf(files, 'index.js');
    expect(witness.status).toBe('COMPLETE');
    expect(flow(witness)).toEqual([
      'INITIALIZER url index.js:4 -> index.js:5', 'DESTRUCTURING host index.js:2 -> index.js:4', 'PROPERTY_READ host index.js:1 -> index.js:2',
      'PROPERTY_WRITE path index.js:3 -> index.js:4',
    ]);
  });

  it('follows a value across files: source → return → imported call → argument → parameter → use', async () => {
    const files: Files = {
      'index.js': lines("const { collect } = require('./collect');", "const { send } = require('./send');", 'const data = collect();', 'send(data);'),
      'collect.js': lines('exports.collect = function collect() {', '  const env = process.env;', '  return env;', '};'),
      'send.js': lines('exports.send = function send(payload) {', '  post({ body: payload }); // FINDING', '};'),
    };
    const { witness } = await inputOf(files, 'send.js');
    expect(witness.status).toBe('COMPLETE');
    expect(flow(witness)).toEqual([
      'ARGUMENT_TO_PARAMETER payload index.js:4 -> send.js:1', 'INITIALIZER data index.js:3 -> index.js:4', 'RETURN collect collect.js:3 -> index.js:3', 'INITIALIZER env collect.js:2 -> collect.js:3',
    ]);
    expect(sites(witness)).toEqual(['send.js:1', 'index.js:4', 'index.js:2', 'index.js:3', 'index.js:1', 'collect.js:1-4']);
  });

  it('follows an imported value and a closure variable', async () => {
    const files: Files = {
      'index.mjs': lines("import { endpoint } from './config.mjs';", 'function make() {', '  const secret = process.env.SECRET;', '  return function inner() {', '    post(endpoint, secret); // FINDING', '  };', '}'),
      'config.mjs': lines("const base = 'https://example.test';", 'export const endpoint = base;'),
    };
    const { witness } = await inputOf(files, 'index.mjs', 'FINDING', postinstall('node index.mjs'));
    expect(witness.status).toBe('COMPLETE');
    expect(flow(witness)).toEqual([
      'IMPORT_EXPORT endpoint index.mjs:1 -> index.mjs:5', 'IMPORT_EXPORT endpoint config.mjs:2 -> index.mjs:1', 'ALIAS endpoint config.mjs:2 -> config.mjs:2', 'INITIALIZER base config.mjs:1 -> config.mjs:2',
      'CLOSURE secret index.mjs:3 -> index.mjs:5',
    ]);
  });

  it('follows an argument handed to a callback explicitly and the result of a settled promise', async () => {
    const explicit: Files = { 'index.js': lines('function each(visit) {', '  visit(process.env.HOME);', '}', 'each((home) => {', '  post(home); // FINDING', '});') };
    const handed = (await inputOf(explicit, 'index.js')).witness;
    expect(handed.status).toBe('COMPLETE');
    expect(flow(handed)).toEqual(['CALLBACK_ARGUMENT home index.js:2 -> index.js:4']);
    const settled: Files = { 'index.js': lines('const seed = process.env.SEED;', 'Promise.resolve(seed).then((value) => {', '  post(value); // FINDING', '});') };
    const result = (await inputOf(settled, 'index.js')).witness;
    expect(flow(result)).toEqual(['PROMISE_RESULT value index.js:2 -> index.js:2', 'INITIALIZER seed index.js:1 -> index.js:2']);
    expect(result.edges[0]!.evidence).toBe('CONFIRMED_ASYNC');
    expect(result.status).toBe('COMPLETE');
  });

  it.each([
    ['a computed property', ['const table = load();', 'post(table[key]); // FINDING'], 'COMPUTED_PROPERTY'],
    ['eval', ["const value = eval('1 + 1');", 'post(value); // FINDING'], 'DYNAMIC_EVALUATION'],
    ['a reflective read', ["const value = Reflect.get(target, 'a');", 'post(value); // FINDING'], 'DYNAMIC_EVALUATION'],
    ['a Proxy', ['const value = new Proxy(target, handler);', 'post(value); // FINDING'], 'DYNAMIC_EVALUATION'],
    ['a property of this', ['function Sender() {', '  post(this.secret); // FINDING', '}'], 'THIS_PROPERTY'],
    ['a parameter nobody is seen to pass', ['exports.send = function send(payload) {', '  post(payload); // FINDING', '};'], 'NO_CALLER_FOUND'],
    ['a callback argument supplied at run time', ["const fs = require('fs');", "fs.readFile('a', (error, data) => {", '  post(data); // FINDING', '});'], 'CALLBACK_ARGUMENT_FROM_RUNTIME'],
    ['a callee passed in as a parameter', ['function run(make) {', '  const value = make();', '  post(value); // FINDING', '}'], 'CALLEE_PARAMETER'],
    ['a destructuring assignment', ['let a;', '[a] = list;', 'post(a); // FINDING'], 'COMPLEX_ASSIGNMENT'],
  ])('leaves %s unresolved instead of guessing', async (_name, source, reason) => {
    const { witness } = await inputOf({ 'index.js': lines(...source) }, 'index.js');
    expect(witness.status).toBe('INCOMPLETE');
    expect(witness.unresolved.map((item) => item.reason)).toContain(reason);
  });

  it('reports no flow for a statement that uses only literals, and stops at the depth limit', async () => {
    expect((await inputOf({ 'index.js': lines("post('https://example.test'); // FINDING") }, 'index.js')).witness).toMatchObject({ status: 'NONE', edges: [], statements: [] });
    const chain = ['const v0 = process.env.A;'];
    for (let depth = 1; depth <= 6; depth += 1) chain.push(`const v${depth} = v${depth - 1};`);
    chain.push('post(v6); // FINDING');
    const files: Files = { 'index.js': lines(...chain) };
    expect((await inputOf(files, 'index.js')).witness.status).toBe('COMPLETE');
    const index = await indexOf(files, postinstall(), { limits: { maxDataFlowDepth: 3 } });
    const shallow = findInputWitness(index, { artifactId: ARTIFACT, filePath: 'index.js' }, { startLine: 8, endLine: 8 });
    expect(shallow.status).toBe('INCOMPLETE');
    expect(shallow.limitations).toContain('DEPTH_LIMIT');
    expect(shallow.conditional).toEqual({ eligible: false, reason: 'NO_PROBABLE_EDGE' });
  });

  /** `v0` is read from the environment and each `v<n>` copies the one before; the Finding uses the last. */
  const valueChain = (copies: number, probable: boolean): Files => {
    // A property of an object that is assigned again is read with a probable edge.
    const source = probable ? ['let box = { value: process.env.A };', 'box = box;', 'const v0 = box.value;'] : ['const v0 = process.env.A;'];
    for (let depth = 1; depth <= copies; depth += 1) source.push(`const v${depth} = v${depth - 1};`);
    source.push(`post(v${copies}); // FINDING`);
    return { 'index.js': lines(...source) };
  };

  it('follows a value flow for sixteen steps', async () => {
    const deep = (await inputOf(valueChain(15, false), 'index.js')).witness;
    expect(deep).toMatchObject({ status: 'COMPLETE', exploredDepth: 16, probableEdgeCount: 0, limitations: [] });
    const tooDeep = (await inputOf(valueChain(16, false), 'index.js')).witness;
    expect(tooDeep.status).toBe('INCOMPLETE');
    expect(tooDeep.limitations).toEqual(['DEPTH_LIMIT']);

    const withProbable = (await inputOf(valueChain(5, true), 'index.js')).witness;
    expect(withProbable).toMatchObject({ status: 'INCOMPLETE', probableEdgeCount: 1, limitations: [], unresolved: [], conditional: { eligible: true, reason: 'ONE_PROBABLE_EDGE' } });
    expect(withProbable.edges.find((edge) => edge.evidence === 'PROBABLE')).toMatchObject({ kind: 'PROPERTY_READ', name: 'value' });
  });

  it('does not let the answer settle a flow with two probable edges, an unresolved step or an unconfirmed promise', async () => {
    const twice: Files = { 'index.js': lines('let a = { x: process.env.A };', 'a = a;', 'let b = { y: a.x };', 'b = b;', 'post(b.y); // FINDING') };
    const double = (await inputOf(twice, 'index.js')).witness;
    expect(double).toMatchObject({ probableEdgeCount: 2, limitations: [], unresolved: [] });
    const open: Files = { 'index.js': lines('let box = { value: table[key] };', 'box = box;', 'post(box.value); // FINDING') };
    expect((await inputOf(open, 'index.js')).witness).toMatchObject({ probableEdgeCount: 1, conditional: { eligible: false, reason: 'FLOW_NOT_COMPLETE' } });
    const promised: Files = { 'index.js': lines('load().then((value) => {', '  post(value); // FINDING', '});') };
    expect((await inputOf(promised, 'index.js')).witness.conditional.eligible).toBe(false);
  });
});

describe('program index: ACTION, TARGET and LINK paths', () => {
  const target = (behavior: BehaviorGroup = 'NETWORK_SEND') => ({ groupId: 'G1', findingId: 'F1', behavior });
  async function pathsOf(files: Files, file: string, behavior: BehaviorGroup = 'NETWORK_SEND', marker = 'FINDING') {
    const index = await indexOf(files);
    const line = lineOf(files, file, marker);
    const paths = buildActionPaths(index, { artifactId: ARTIFACT, filePath: file }, { startLine: line, endLine: line }, target(behavior), ['ACTION', 'TARGET', 'LINK']);
    const of = (context: ContextCode) => paths.find((path) => path.context === context)!;
    return { action: of('ACTION'), target: of('TARGET'), link: of('LINK') };
  }
  const where = (path: ContextWitnessPath): string[] => path.statements.map((item) => `${item.filePath}:${item.startLine}${item.endLine === item.startLine ? '' : `-${item.endLine}`}`);

  it('ends ACTION at the Finding when the operation API is called there, and traces TARGET and LINK from its arguments', async () => {
    const files: Files = { 'index.js': lines("const https = require('https');", "const url = 'https://example.test';", 'const body = process.env.TOKEN;', 'https.request(url, { body }); // FINDING') };
    const { action, target: destination, link } = await pathsOf(files, 'index.js');
    expect(action).toMatchObject({ context: 'ACTION', complete: true, depth: 0, statements: [] });
    expect(destination.complete).toBe(true);
    expect(where(destination)).toEqual(['index.js:2', 'index.js:4']);
    expect(link.complete).toBe(true);
    expect(where(link)).toEqual(['index.js:2', 'index.js:3']);
  });

  it('links only the exact source Finding through its container to a later direct use', async () => {
    const files: Files = { 'index.js': lines(
      "const os = require('os');",
      "const https = require('https');",
      'const trackingData = JSON.stringify({',
      '  hostname: os.hostname(), // FINDING',
      "  directories: listDirectory('/root')",
      '});',
      'const req = https.request(options);',
      'req.write(trackingData);',
    ) };
    const index = await indexOf(files);
    const line = lineOf(files, 'index.js', 'FINDING');
    const links = buildActionPaths(index, { artifactId: ARTIFACT, filePath: 'index.js' }, { startLine: line, endLine: line }, target('OTHER'), ['LINK']);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ complete: true, findingId: 'F1', sink: { callee: 'req.write', startLine: 8, endLine: 8 } });
    expect(where(links[0]!)).toEqual(['index.js:3-6', 'index.js:8']);
    expect(links[0]!.steps.map((step) => step.basis)).toEqual(['OBJECT_PROPERTY', 'STATIC_CONTAINER_CALL', 'VARIABLE_INITIALIZER', 'DIRECT_CALL_ARGUMENT']);
  });

  it('keeps an inline readable listener and its handler as one ACTION statement', async () => {
    const files: Files = { 'index.js': lines(
      'function collect(stream, chunks) {',
      "  stream.on('readable', () => {",
      '    let chunk;',
      '    while ((chunk = stream.read()) !== null) { // FINDING',
      '      chunks.push(chunk);',
      '    }',
      '  });',
      '}',
    ) };
    const index = await indexOf(files);
    const line = lineOf(files, 'index.js', 'FINDING');
    const [action] = buildActionPaths(index, { artifactId: ARTIFACT, filePath: 'index.js' }, { startLine: line, endLine: line }, target('OTHER'), ['ACTION']);
    expect(action).toMatchObject({ complete: true, sink: { callee: 'stream.read', startLine: 2, endLine: 7 } });
    expect(where(action!)).toEqual(['index.js:2-7']);
  });

  it('follows wrappers, in the file and across files, to the call of the operation API', async () => {
    const files: Files = {
      'index.js': lines("const { upload } = require('./net');", 'const data = process.env.TOKEN;', 'upload(data); // FINDING'),
      'net.js': lines("const https = require('https');", "const HOST = 'https://example.test';", 'function post(payload) {', '  https.request(HOST).end(payload);', '}', 'exports.upload = function upload(value) {', '  post(value);', '};'),
    };
    const { action, target: destination, link } = await pathsOf(files, 'index.js');
    expect(action).toMatchObject({ complete: true, depth: 2, confirmedEdgeCount: 2, probableEdgeCount: 0 });
    expect(action.steps.map((step) => `${step.kind} ${step.statement.filePath}:${step.statement.startLine}`)).toEqual(['CALL index.js:3', 'CALL net.js:7']);
    // The call, the require and export that name the wrapper, each wrapper's declaration, and the call of the API.
    expect(where(action)).toEqual(['index.js:3', 'index.js:1', 'net.js:6', 'net.js:7', 'net.js:3', 'net.js:4']);
    // TARGET: the first argument of https.request is the constant HOST.
    expect(destination.complete).toBe(true);
    expect(where(destination)).toEqual(['net.js:2', 'net.js:4']);
    // LINK: `payload` reaches the call through both wrappers' parameters, from the value read in index.js.
    expect(link.complete).toBe(true);
    expect(where(link)).toEqual(['net.js:2', 'net.js:3', 'net.js:6-8', 'index.js:1', 'index.js:2', 'index.js:3', 'net.js:4']);
  });

  it('takes a built-in of the behavior as the operation, never an external library inside a wrapper', async () => {
    const wrapper = (module: string, call: string): Files => ({
      'index.js': lines(`const lib = require('${module}');`, 'function run(input) {', `  ${call};`, '}', 'run(process.argv[2]); // FINDING'),
    });
    const cases: Array<[BehaviorGroup, string, string, boolean]> = [
      ['NETWORK_SEND', 'https', 'lib.request(input)', true], ['NETWORK_SEND', 'node:http', 'lib.get(input)', true], ['NETWORK_SEND', 'dns', 'lib.lookup(input)', true],
      ['PROCESS_EXEC', 'child_process', 'lib.exec(input)', true], ['REMOTE_SHELL', 'net', 'lib.connect(input)', false], ['REMOTE_SHELL', 'child_process', 'lib.spawn(input)', false],
      ['FILE_MUTATION', 'fs', 'lib.writeFileSync(input, 1)', true], ['SENSITIVE_READ', 'fs/promises', 'lib.readFile(input)', true], ['PERSISTENCE', 'node:fs', 'lib.appendFileSync(input, 1)', true],
      ['DYNAMIC_CODE', 'vm', 'lib.runInThisContext(input)', true], ['SYSTEM_DISCOVERY', 'os', 'lib.hostname()', true], ['DOWNLOAD_AND_EXECUTE', 'child_process', 'lib.execSync(input)', false],
      // A built-in of another behavior, and any dependency, is not the operation of this one.
      ['NETWORK_SEND', 'fs', 'lib.readFileSync(input)', false], ['PROCESS_EXEC', 'https', 'lib.request(input)', false],
      ['NETWORK_SEND', 'superagent', 'lib.post(input)', true], ['PROCESS_EXEC', 'cross-spawn', 'lib(input)', true], ['OTHER', 'https', 'lib.request(input)', false],
    ];
    for (const [behavior, module, call, sink] of cases) {
      const { action } = await pathsOf(wrapper(module, call), 'index.js', behavior);
      expect(`${behavior} ${module} ${action.complete}`).toBe(`${behavior} ${module} ${sink}`);
      if (!sink) expect(action.failureReason).toBe(COMPOSITE_ACTION_STAGES[behavior] ? 'COMPOSITE_INCOMPLETE' : 'EXTERNAL_BOUNDARY');
    }
    // Globals of the behavior count as well, unless the name is bound to something else.
    const viaGlobal = (source: string[]): Files => ({ 'index.js': lines(...source) });
    expect((await pathsOf(viaGlobal(['function run(input) {', '  fetch(input);', '}', 'run(url); // FINDING']), 'index.js')).action.complete).toBe(true);
    expect((await pathsOf(viaGlobal(['function run(input) {', '  eval(input);', '}', 'run(code); // FINDING']), 'index.js', 'DYNAMIC_CODE')).action.complete).toBe(true);
    expect((await pathsOf(viaGlobal(['const fetch = pick();', 'function run(input) {', '  fetch(input);', '}', 'run(url); // FINDING']), 'index.js')).action).toMatchObject({ complete: false });
    expect(isActionModule('NETWORK_SEND', 'node:https', 'request')).toBe(true);
    expect(isActionModule('NETWORK_SEND', 'node:https')).toBe(false);
    expect(isActionModule('NETWORK_SEND', 'node:https', 'createServer')).toBe(false);
    expect(isActionModule('FILE_MUTATION', 'fs', 'writeFileSync')).toBe(true);
    expect(isActionModule('FILE_MUTATION', 'fs', 'readFileSync')).toBe(false);
    expect(isActionModule('SENSITIVE_READ', 'fs', 'readFileSync')).toBe(true);
    expect(isActionModule('SENSITIVE_READ', 'fs', 'existsSync')).toBe(false);
    expect(isActionGlobal('NETWORK_SEND', 'eval')).toBe(false);
    expect(Object.keys(ACTION_FAMILIES_BY_BEHAVIOR).sort()).toEqual([...BEHAVIOR_GROUPS].sort());
    expect(ACTION_API_FAMILIES.NETWORK.modules).toEqual(['http', 'https', 'http2', 'net', 'tls', 'dns']);
  });

  it('requires the exact built-in origin and member through require/import aliases', async () => {
    const complete = async (imports: string, call: string, behavior: BehaviorGroup = 'NETWORK_SEND') => (
      await pathsOf({ 'index.js': lines(imports, 'function run(input) {', `  ${call};`, '}', 'run(value); // FINDING') }, 'index.js', behavior)
    ).action.complete;
    expect(await complete("const { request: send } = require('node:https');", 'send(input)')).toBe(true);
    expect(await complete("import transport from 'node:https';", 'transport.request(input)')).toBe(true);
    expect(await complete("import { request as send } from 'node:https';", 'send(input)')).toBe(true);
    expect(await complete("import * as transport from 'node:https';", 'transport.request(input)')).toBe(true);
    expect(await complete("const transport = require('node:https');", 'transport.createServer(input)')).toBe(false);
    expect(await complete('const transport = { request(value) { return value; } };', 'transport.request(input)')).toBe(false);
    expect(await complete('function request(value) { return value; }', 'request(input)')).toBe(false);
  });

  it('traces TARGET and LINK through only the exact call that reached the chosen sink', async () => {
    const files: Files = { 'index.js': lines(
      "const https = require('https');",
      'function send(url, payload) {',
      '  https.request(url, { body: payload });',
      '}',
      "const chosen = 'https://chosen.test';",
      'send(chosen, process.env.CHOSEN); // FINDING',
      "send('https://unrelated.test', process.env.UNRELATED);",
    ) };
    const { target: destination, link } = await pathsOf(files, 'index.js');
    expect(destination.complete).toBe(true);
    expect(link.complete).toBe(true);
    expect(where(destination)).toContain('index.js:5');
    expect(where(destination)).not.toContain('index.js:7');
    expect(where(link)).not.toContain('index.js:7');
  });

  it('takes an external call as the operation only where the Finding itself points at it', async () => {
    const atFinding: Files = { 'index.js': lines("const agent = require('private-agent');", 'agent.post(url, data); // FINDING') };
    expect((await pathsOf(atFinding, 'index.js')).action).toMatchObject({ complete: true, depth: 0 });
    const inWrapper: Files = { 'index.js': lines("const agent = require('private-agent');", 'function send(data) {', '  agent.post(url, data);', '}', 'send(1); // FINDING') };
    const { action, target: destination, link } = await pathsOf(inWrapper, 'index.js');
    expect(action).toMatchObject({ complete: false, failureReason: 'EXTERNAL_BOUNDARY', statements: [] });
    expect(destination).toMatchObject({ complete: false, failureReason: 'EXTERNAL_BOUNDARY' });
    expect(link).toMatchObject({ complete: false, failureReason: 'EXTERNAL_BOUNDARY' });
  });

  it('says why no path was completed', async () => {
    const dynamic: Files = { 'index.js': lines('function run(handler, input) {', '  handler(input);', '}', 'run(pick(), value); // FINDING') };
    expect((await pathsOf(dynamic, 'index.js')).action).toMatchObject({ complete: false, failureReason: 'DYNAMIC_DISPATCH' });
    const none: Files = { 'index.js': lines('function run(input) {', '  return input + 1;', '}', 'run(2); // FINDING') };
    expect((await pathsOf(none, 'index.js')).action).toMatchObject({ complete: false, failureReason: 'NO_COMPLETE_PATH' });
    const chain = ["const https = require('https');", 'function f0(v) {', '  https.request(v);', '}'];
    for (let depth = 1; depth <= 17; depth += 1) chain.push(`function f${depth}(v) {`, `  f${depth - 1}(v);`, '}');
    chain.push('f17(url); // FINDING');
    expect((await pathsOf({ 'index.js': lines(...chain) }, 'index.js')).action).toMatchObject({ complete: false, failureReason: 'DEPTH_LIMIT' });
    const twice: Files = { 'index.js': lines("const https = require('https');", 'function real(v) {', '  https.request(v);', '}', 'let a = real;', 'a = a;', 'function mid(v) {', '  a(v);', '}', 'let b = mid;', 'b = b;', 'b(url); // FINDING') };
    expect((await pathsOf(twice, 'index.js')).action).toMatchObject({ complete: true, probableEdgeCount: 2 });
    const once: Files = { 'index.js': lines("const https = require('https');", 'function real(v) {', '  https.request(v);', '}', 'let a = real;', 'a = a;', 'a(url); // FINDING') };
    expect((await pathsOf(once, 'index.js')).action).toMatchObject({ complete: true, probableEdgeCount: 1, confirmedEdgeCount: 0 });

    // TARGET and LINK stop where the value does.
    const computed: Files = { 'index.js': lines("const https = require('https');", 'https.request(table[key], { body: this.secret }); // FINDING') };
    const stopped = await pathsOf(computed, 'index.js');
    expect(stopped.target).toMatchObject({ complete: false, failureReason: 'DYNAMIC_DISPATCH' });
    expect(stopped.link).toMatchObject({ complete: false, failureReason: 'DYNAMIC_DISPATCH' });
    const exported: Files = { 'index.js': lines("const https = require('https');", 'exports.send = function send(url) {', '  https.request(url); // FINDING', '};') };
    expect((await pathsOf(exported, 'index.js')).target).toMatchObject({ complete: false, failureReason: 'EXTERNAL_BOUNDARY' });
  });

  it('reads an environment variable as the operation of a read, with no value to link into it', async () => {
    const files: Files = { 'index.js': lines('function token() {', '  return process.env.NPM_TOKEN;', '}', 'const value = token(); // FINDING') };
    const { action, target: destination, link } = await pathsOf(files, 'index.js', 'SENSITIVE_READ');
    expect(action).toMatchObject({ complete: true, depth: 1 });
    expect(where(action)).toEqual(['index.js:4', 'index.js:1', 'index.js:2']);
    expect(destination.complete).toBe(true);
    expect(link).toMatchObject({ complete: false, failureReason: 'NO_COMPLETE_PATH' });
    expect((await pathsOf(files, 'index.js', 'NETWORK_SEND')).action.complete).toBe(false);
  });

  it('recognises only centrally listed factory-returned instance members', async () => {
    const factory = async (imports: string[], setup: string[], call: string, behavior: BehaviorGroup = 'NETWORK_SEND') => pathsOf({
      'index.js': lines(...imports, ...setup, 'function run(input) {', `  ${call};`, '}', 'run(value); // FINDING'),
    }, 'index.js', behavior);
    expect((await factory(["const dgram = require('node:dgram');"], ["const socket = dgram.createSocket('udp4');"], "socket.send(input, 53, 'example.test')")).action)
      .toMatchObject({ complete: true, sink: { callee: 'socket.send' } });
    expect((await factory(["const dgram = require('dgram');"], [], "dgram.createSocket('udp4').send(input, 53, 'example.test')")).action.complete).toBe(true);
    expect((await factory(["const axios = require('axios');"], ['const client = axios.create();'], 'client.post(input)')).action.complete).toBe(true);
    expect((await factory(["const { create: makeClient } = require('axios');"], ['const client = makeClient();'], 'client.post(input)')).action.complete).toBe(true);
    expect((await factory(["import axios from 'axios';"], ['const first = axios.create();', 'const client = first;'], 'client.get(input)')).action.complete).toBe(true);
    expect((await factory(["const got = require('got');"], ['const client = got.extend({});'], 'client.post(input)')).action.complete).toBe(true);
    expect((await factory(["const superagent = require('superagent');"], ['const client = superagent.agent();'], 'client.get(input)')).action.complete).toBe(true);
    expect(BUILTIN_ACTION_FACTORIES.dgram!.createSocket!.instance.members).toEqual(['send']);
    expect(Object.keys(EXTERNAL_ACTION_FACTORIES).sort()).toEqual(['axios', 'got', 'superagent']);
  });

  it('does not infer unknown factories, instance members, computed members, local lookalikes or reassigned factory results', async () => {
    const incomplete = async (source: string[]) => (await pathsOf({ 'index.js': lines(...source) }, 'index.js')).action;
    await expect(incomplete(["const axios = require('axios');", 'const client = axios.build();', 'function run(input) { client.post(input); }', 'run(value); // FINDING']))
      .resolves.toMatchObject({ complete: false });
    await expect(incomplete(["const axios = require('axios');", 'const client = axios.create();', 'function run(input) { client.use(input); }', 'run(value); // FINDING']))
      .resolves.toMatchObject({ complete: false });
    await expect(incomplete(["const axios = require('axios');", 'const client = axios.create();', 'function run(input) { client[method](input); }', 'run(value); // FINDING']))
      .resolves.toMatchObject({ complete: false, failureReason: 'DYNAMIC_DISPATCH' });
    await expect(incomplete(['const axios = { create() { return fake; } };', 'const client = axios.create();', 'function run(input) { client.post(input); }', 'run(value); // FINDING']))
      .resolves.toMatchObject({ complete: false });
    await expect(incomplete(["const axios = require('axios');", 'let client = axios.create();', 'client = other;', 'function run(input) { client.post(input); }', 'run(value); // FINDING']))
      .resolves.toMatchObject({ complete: false });
  });

  it.each([
    ['COLLECT_AND_SEND', ["const fs = require('fs');", "const axios = require('axios');", 'function run(path) {', '  const value = fs.readFileSync(path);', '  axios.post(url, value);', '}', 'run(file); // FINDING'], ['COLLECT', 'SEND']],
    ['DOWNLOAD_AND_EXECUTE', ["const axios = require('axios');", "const cp = require('child_process');", 'function run(url) {', '  const code = axios.get(url);', '  cp.exec(code);', '}', 'run(remote); // FINDING'], ['DOWNLOAD', 'EXECUTE']],
    ['REMOTE_SHELL', ["const net = require('net');", "const cp = require('child_process');", 'function run(host) {', '  const command = net.connect(host);', '  cp.exec(command);', '}', 'run(remote); // FINDING'], ['REMOTE_CHANNEL', 'SHELL_EXECUTION']],
  ] as Array<[BehaviorGroup, string[], string[]]>)('builds a COMPLETE connected composite witness for %s', async (behavior, source, stages) => {
    const { action } = await pathsOf({ 'index.js': lines(...source) }, 'index.js', behavior);
    expect(action).toMatchObject({ complete: true, composite: { behavior, status: 'COMPLETE', requiredStages: stages, confirmedStages: stages, missingStages: [], missingConnections: [], complete: true } });
    expect(action.composite!.stageWitnesses).toHaveLength(2);
    expect(action.composite!.connectionWitnesses).toMatchObject([{ fromStage: stages[0], toStage: stages[1], kind: 'VALUE_FLOW' }]);
    expect(where(action)).toEqual(expect.arrayContaining(['index.js:3-6', 'index.js:7']));
  });

  it('records missing and unconnected composite stages as PARTIAL', async () => {
    const sendOnly = await pathsOf({ 'index.js': lines("const axios = require('axios');", 'function run(value) {', '  axios.post(url, value);', '}', 'run(input); // FINDING') }, 'index.js', 'COLLECT_AND_SEND');
    expect(sendOnly.action).toMatchObject({ complete: false, failureReason: 'COMPOSITE_INCOMPLETE', composite: {
      status: 'PARTIAL', confirmedStages: ['SEND'], missingStages: ['COLLECT'], missingConnections: [], complete: false,
    } });
    const unconnected = await pathsOf({ 'index.js': lines(
      "const fs = require('fs');", "const axios = require('axios');", 'function run(path, other) {', '  fs.readFileSync(path);', '  axios.post(url, other);', '}', 'run(file, unrelated); // FINDING',
    ) }, 'index.js', 'COLLECT_AND_SEND');
    expect(unconnected.action).toMatchObject({ complete: false, failureReason: 'COMPOSITE_INCOMPLETE', composite: {
      status: 'PARTIAL', confirmedStages: ['COLLECT', 'SEND'], missingStages: [], missingConnections: ['COLLECT->SEND'], complete: false,
    } });
  });

  it('accepts a statically nested composite call without guessing a return type', async () => {
    const nested = await pathsOf({ 'index.js': lines(
      "const axios = require('axios');", "const cp = require('child_process');", 'function run(url) {', '  cp.exec(axios.get(url));', '}', 'run(remote); // FINDING',
    ) }, 'index.js', 'DOWNLOAD_AND_EXECUTE');
    expect(nested.action).toMatchObject({ complete: true, composite: {
      status: 'COMPLETE', connectionWitnesses: [{ fromStage: 'DOWNLOAD', toStage: 'EXECUTE', kind: 'NESTED_CALL' }],
    } });
  });
});

describe('program index: external library sinks', () => {
  const sinkOf = async (source: string[], behavior: BehaviorGroup, extra: Files = {}) => {
    const files: Files = { 'index.js': lines(...source), ...extra };
    const index = await indexOf(files, postinstall());
    const line = lineOf(files, 'index.js', 'FINDING');
    const [action] = buildActionPaths(index, { artifactId: ARTIFACT, filePath: 'index.js' }, { startLine: line, endLine: line }, { groupId: 'G1', findingId: 'F1', behavior }, ['ACTION']);
    return action!;
  };
  const wrapped = (imports: string[], call: string): string[] => [...imports, 'function run(input) {', `  ${call};`, '}', 'run(process.argv[2]); // FINDING'];

  it.each([
    ['NETWORK_SEND', ["const axios = require('axios');"], 'axios.post(input, {})'],
    ['NETWORK_SEND', ["const axios = require('axios');"], 'axios(input)'],
    ['NETWORK_SEND', ["const http = require('axios').default;"], 'http.get(input)'],
    ['NETWORK_SEND', ["const { post: send } = require('axios');"], 'send(input)'],
    ['DOWNLOAD', ["const request = require('request');"], 'request.get(input)'],
    ['DOWNLOAD', ["const got = require('got');", 'const fetchIt = got;'], 'fetchIt(input)'],
    ['PROCESS_EXEC', ["const execa = require('execa');"], 'execa(input)'],
    ['PROCESS_EXEC', ["const shell = require('shelljs');"], 'shell.exec(input)'],
    ['FILE_MUTATION', ["const fse = require('fs-extra');"], 'fse.outputFileSync(input, 1)'],
    ['FILE_MUTATION', ["const shell = require('shelljs');"], 'shell.rm(input)'],
    ['FILE_MUTATION', ["const tar = require('tar');"], 'tar.x({ file: input })'],
    ['FILE_MUTATION', ["const extract = require('extract-zip');"], 'extract(input, {})'],
    ['FILE_MUTATION', ["const AdmZip = require('adm-zip');", 'const zip = new AdmZip(archive);'], 'zip.extractAllTo(input)'],
    ['FILE_MUTATION', ["const unzipper = require('unzipper');"], 'unzipper.Open.file(input)'],
  ] as Array<[BehaviorGroup, string[], string]>)('takes %s through `%s` / `%s` as the operation, by where the name was required from', async (behavior, imports, call) => {
    const action = await sinkOf(wrapped(imports, call), behavior);
    expect(action).toMatchObject({ complete: true, depth: 1 });
    expect(action.steps[0]).toMatchObject({ kind: 'CALL', evidence: 'CONFIRMED', basis: 'STATIC_CALLEE' });
  });

  it('recognises default, named and namespace imports', async () => {
    const esm = (imports: string, call: string) => wrapped([imports], call);
    expect((await sinkOf(esm("import axios from 'axios';", 'axios.post(input)'), 'NETWORK_SEND')).complete).toBe(true);
    expect((await sinkOf(esm("import { execa } from 'execa';", 'execa(input)'), 'PROCESS_EXEC')).complete).toBe(true);
    expect((await sinkOf(esm("import { execa as run2 } from 'execa';", 'run2(input)'), 'PROCESS_EXEC')).complete).toBe(true);
    expect((await sinkOf(esm("import * as shell from 'shelljs';", 'shell.exec(input)'), 'PROCESS_EXEC')).complete).toBe(true);
    expect((await sinkOf(esm("import * as fse from 'fs-extra';", 'fse.copy(input, out)'), 'FILE_MUTATION')).complete).toBe(true);
  });

  it.each([
    ['a member that is not listed', 'NETWORK_SEND', ["const axios = require('axios');"], 'axios.create(input)', 'EXTERNAL_BOUNDARY'],
    ['a library of another behavior', 'NETWORK_SEND', ["const execa = require('execa');"], 'execa(input)', 'EXTERNAL_BOUNDARY'],
    ['a library that is not listed', 'NETWORK_SEND', ["const client = require('private-client');"], 'client.post(input)', 'EXTERNAL_BOUNDARY'],
    ['a local function with a library name', 'NETWORK_SEND', ['function axios(value) {', '  return value;', '}'], 'axios(input)', 'NO_COMPLETE_PATH'],
    ['a name from a file of the package', 'NETWORK_SEND', ["const axios = require('./axios');"], 'axios.post(input)', 'NO_COMPLETE_PATH'],
    ['a name whose origin is a parameter', 'PROCESS_EXEC', ['const tools = pick();'], 'tools.exec(input)', 'NO_COMPLETE_PATH'],
    ['a computed member', 'PROCESS_EXEC', ["const shell = require('shelljs');"], 'shell[method](input)', 'DYNAMIC_DISPATCH'],
  ] as Array<[string, BehaviorGroup, string[], string, string]>)('does not take %s as the operation', async (_name, behavior, imports, call, reason) => {
    const action = await sinkOf(wrapped(imports, call), behavior, { 'axios.js': 'exports.post = function post(value) { return value; };\n' });
    expect(action).toMatchObject({ complete: false, failureReason: reason });
  });

  it('keeps the listed libraries in one mapping, by behavior', () => {
    expect(Object.keys(EXTERNAL_ACTION_APIS.NETWORK).sort()).toEqual(['axios', 'cross-fetch', 'got', 'needle', 'node-fetch', 'request', 'superagent', 'undici']);
    expect(Object.keys(EXTERNAL_ACTION_APIS.FILE_READ)).toEqual(['fs-extra']);
    expect(Object.keys(EXTERNAL_ACTION_APIS.FILE_MUTATION).sort()).toEqual(['fs-extra', 'shelljs']);
    expect(isExternalAction('NETWORK_SEND', 'axios', 'post')).toBe(true);
    expect(isExternalAction('NETWORK_SEND', 'axios', 'default.post')).toBe(true);
    expect(isExternalAction('NETWORK_SEND', 'axios', undefined)).toBe(true);
    expect(isExternalAction('NETWORK_SEND', 'axios', 'create')).toBe(false);
    expect(isExternalAction('PROCESS_EXEC', 'shelljs', 'rm')).toBe(false);
    expect(isExternalAction('FILE_MUTATION', 'shelljs', 'rm')).toBe(true);
    expect(isExternalAction('FILE_MUTATION', 'fs-extra', 'pathExists')).toBe(false);
    expect(isExternalAction('SYSTEM_DISCOVERY', 'systeminformation', 'cpu')).toBe(true);
    expect(isExternalAction('SYSTEM_DISCOVERY', 'systeminformation', 'madeUp')).toBe(false);
    expect(isExternalAction('FILE_MUTATION', 'adm-zip', '().extractAllTo')).toBe(true);
    expect(isExternalAction('FILE_MUTATION', 'adm-zip', 'extractAllTo')).toBe(false);
  });
});

describe('program index: callback registration and execution', () => {
  const stepOf = async (source: string[]) => {
    const files: Files = { 'index.js': lines(...source) };
    const { witness } = await trigger(files, 'index.js');
    return { witness, step: witness.steps.find((item) => item.kind === 'CALLBACK')! };
  };
  const at = (ref: { startLine: number } | undefined) => ref?.startLine;

  it('ties a callback to where it is handed over and where it is run, with the basis of the verdict', async () => {
    const array = await stepOf(["['a'].forEach((item) => {", '  use(item); // FINDING', '});']);
    expect(array.step).toMatchObject({ evidence: 'CONFIRMED', callbackKind: 'SYNCHRONOUS_CALLBACK', basis: 'ARRAY_RECEIVER' });
    expect([at(array.step.registeredAt), at(array.step.executedAt)]).toEqual([1, 1]);
    const direct = await stepOf(['function each(list, visit) {', '  for (const item of list) visit(item);', '}', 'each(names, (name) => {', '  use(name); // FINDING', '});']);
    expect(direct.step).toMatchObject({ evidence: 'CONFIRMED', basis: 'PARAMETER_CALLED_BY_CALLEE' });
    expect([at(direct.step.registeredAt), at(direct.step.executedAt)]).toEqual([4, 2]);
    const emitted = await stepOf(["const { EventEmitter } = require('events');", 'const bus = new EventEmitter();', "const EVENT = 'go';", 'bus.on(EVENT, () => {', '  use(1); // FINDING', '});', 'bus.emit(EVENT);']);
    expect(emitted.step).toMatchObject({ evidence: 'CONFIRMED', callbackKind: 'LOCALLY_EMITTED_EVENT', basis: 'LISTENER_ADDED_BEFORE_LOCAL_EMIT' });
    expect([at(emitted.step.registeredAt), at(emitted.step.executedAt)]).toEqual([4, 7]);
    expect(emitted.witness.status).toBe('CONFIRMED');
    const settled = await stepOf(['Promise.resolve().then(() => {', '  use(1); // FINDING', '});']);
    expect(settled.step).toMatchObject({ evidence: 'CONFIRMED_ASYNC', basis: 'PROMISE_RESOLVE_THEN' });
    expect(at(settled.step.registeredAt)).toBe(1);
    expect(settled.step.executedAt).toBeUndefined();
    const called = (await trigger({ 'index.js': lines('const later = () => {', '  use(1); // FINDING', '};', 'later();') }, 'index.js')).witness;
    expect(called.steps[0]).toMatchObject({ kind: 'CALL', evidence: 'CONFIRMED', basis: 'STATIC_CALLEE' });
    const immediate = (await trigger({ 'index.js': lines('(() => {', '  use(1); // FINDING', '})();') }, 'index.js')).witness;
    expect(immediate.steps[0]).toMatchObject({ kind: 'IMMEDIATE_CALL', basis: 'IMMEDIATE_INVOCATION' });
  });

  it('connects constant aliases of the same emitter, but never a different emitter', async () => {
    const throughAlias = await stepOf([
      "const { EventEmitter } = require('events');", 'const bus = new EventEmitter();', 'const alias = bus;', "alias.on('go', () => {",
      '  use(1); // FINDING', '});', "bus.emit('go');",
    ]);
    expect(throughAlias.step).toMatchObject({ evidence: 'CONFIRMED', callbackKind: 'LOCALLY_EMITTED_EVENT' });
    const reverseAlias = await stepOf([
      "const { EventEmitter } = require('events');", 'const bus = new EventEmitter();', 'const alias = bus;', "bus.on('go', () => {",
      '  use(1); // FINDING', '});', "alias.emit('go');",
    ]);
    expect(reverseAlias.step).toMatchObject({ evidence: 'CONFIRMED', callbackKind: 'LOCALLY_EMITTED_EVENT' });
    const other = await stepOf([
      "const { EventEmitter } = require('events');", 'const bus = new EventEmitter();', 'const other = new EventEmitter();', "bus.on('go', () => {",
      '  use(1); // FINDING', '});', "other.emit('go');",
    ]);
    expect(other.step).toMatchObject({ evidence: 'CONFIRMED_ASYNC', basis: 'REGISTERED_CALLBACK:NO_LOCAL_EMIT' });
  });

  it.each([
    ['an event name that is not fixed', ["const { EventEmitter } = require('events');", 'const bus = new EventEmitter();', 'bus.on(name, () => {', '  use(1); // FINDING', '});', 'bus.emit(name);'], 'DYNAMIC_EVENT_NAME'],
    ['an emitter that is assigned again', ["const { EventEmitter } = require('events');", 'let bus = new EventEmitter();', 'bus = pick();', "bus.on('go', () => {", '  use(1); // FINDING', '});', "bus.emit('go');"], 'EMITTER_IDENTITY_UNCLEAR'],
    ['an emitter that came from elsewhere', ['function listen(bus) {', "  bus.on('go', () => {", '    use(1); // FINDING', '  });', "  bus.emit('go');", '}', 'listen(make());'], 'EXTERNAL_EVENT'],
    ['another event name', ["const { EventEmitter } = require('events');", 'const bus = new EventEmitter();', "bus.on('go', () => {", '  use(1); // FINDING', '});', "bus.emit('stop');"], 'NO_LOCAL_EMIT'],
    ['a registration that nothing follows', ["const { EventEmitter } = require('events');", 'const bus = new EventEmitter();', "bus.on('go', () => {", '  use(1); // FINDING', '});'], 'NO_LOCAL_EMIT'],
    ['a timer', ['setTimeout(() => {', '  use(1); // FINDING', '}, 0);'], 'TIMER'],
  ])('records a callback as registered, not as called at a known place, with %s', async (_name, source, basis) => {
    const { witness, step } = await stepOf(source);
    expect(step).toMatchObject({ evidence: 'CONFIRMED_ASYNC', basis: `REGISTERED_CALLBACK:${basis}` });
    expect(step.registeredAt).toBeDefined();
    expect(step.executedAt).toBeUndefined();
    expect(witness).toMatchObject({ status: 'CONFIRMED', evidence: 'CONFIRMED_ASYNC' });
  });
});

describe('program index: property and alias value flows', () => {
  const flowOf = async (source: string[], extra: Files = {}) => (await inputOf({ 'index.js': lines(...source), ...extra }, 'index.js')).witness;
  const from = (witness: { statements: Array<{ filePath: string; startLine: number }> }) => witness.statements.map((item) => `${item.filePath}:${item.startLine}`).sort();

  it.each([
    ['a property assigned after the object is made', ['const box = {};', 'box.token = process.env.T;', 'const other = 1;', 'post(box.token); // FINDING'], ['index.js:2']],
    ['a nested property', ['const cfg = { net: { host: process.env.H, port: 1 }, other: load() };', 'post(cfg.net.host); // FINDING'], ['index.js:1']],
    ['a nested property written later', ['const cfg = { net: {} };', 'cfg.net.host = process.env.H;', 'cfg.net.port = load();', 'post(cfg.net.host); // FINDING'], ['index.js:2']],
    ['destructuring with a default', ["const { host = 'localhost', port } = { host: process.env.H, port: load() };", 'post(host); // FINDING'], ['index.js:1']],
    ['nested and array destructuring', ['const [first, { deep }] = [process.env.A, { deep: process.env.B }];', 'post(first, deep); // FINDING'], ['index.js:1']],
    ['an object spread', ['const base = { token: process.env.T };', 'const extra = { other: load() };', 'const all = { ...base, tag: 1 };', 'post(all.token); // FINDING'], ['index.js:1', 'index.js:3']],
    ['an array spread', ['const head = [process.env.A];', 'const all = [...head, process.env.B];', 'post(all); // FINDING'], ['index.js:1', 'index.js:2']],
    ['a variable alias and an object alias', ['const cfg = { token: process.env.T };', 'const same = cfg;', 'const value = same.token;', 'const copy = value;', 'post(copy); // FINDING'], ['index.js:1', 'index.js:2', 'index.js:3', 'index.js:4']],
    ['an argument into a destructured parameter', ['function send({ token, tag }) {', '  post(token); // FINDING', '}', 'send({ token: process.env.T, tag: load() });'], ['index.js:1', 'index.js:4']],
    ['a property of a return value', ['function make() {', '  return { token: process.env.T, other: load() };', '}', 'post(make().token); // FINDING'], ['index.js:1']],
    ['a fixed array index, stored and read', ['const parts = [];', 'parts[0] = process.env.A;', 'parts[1] = load();', 'post(parts[0]); // FINDING'], ['index.js:2']],
    ['an element of an array literal', ['const parts = [process.env.A, load()];', 'post(parts[0]); // FINDING'], ['index.js:1']],
  ])('follows %s to where the value comes from', async (_name, source, statements) => {
    const witness = await flowOf(source);
    expect({ status: witness.status, unresolved: witness.unresolved.map((item) => item.reason) }).toEqual({ status: 'COMPLETE', unresolved: [] });
    expect(from(witness)).toEqual(statements);
  });

  it('follows a property of a module of the package into the file that exports it', async () => {
    const witness = await flowOf(["const config = require('./config');", 'post(config.token); // FINDING'], { 'config.js': lines('const secret = process.env.T;', 'module.exports = { token: secret, other: 1 };') });
    expect(witness.status).toBe('COMPLETE');
    expect(from(witness)).toEqual(['config.js:1', 'config.js:2', 'index.js:1']);
  });

  it.each([
    ['a property under a computed key', ['const box = { a: 1 };', 'post(box[key]); // FINDING'], 'COMPUTED_PROPERTY'],
    ['a write under a computed key', ['const box = { token: 1 };', 'box[key] = process.env.T;', 'post(box.token); // FINDING'], 'COMPUTED_PROPERTY'],
    ['a computed index', ['const parts = [1, 2];', 'post(parts[position]); // FINDING'], 'COMPUTED_PROPERTY'],
    ['a fixed index after the array was changed in place', ['const parts = [1];', 'parts.push(process.env.T);', 'post(parts[0]); // FINDING'], 'ARRAY_MUTATION'],
    ['a prototype that is replaced', ['const box = { token: 1 };', 'Object.setPrototypeOf(box, other);', 'post(box.token); // FINDING'], 'PROTOTYPE_MUTATION'],
    ['a write through __proto__', ['const box = { token: 1 };', 'box.__proto__.token = process.env.T;', 'post(box.token); // FINDING'], 'PROTOTYPE_MUTATION'],
    ['a Proxy', ['const box = new Proxy(target, handler);', 'post(box.token); // FINDING'], 'DYNAMIC_EVALUATION'],
    ['a computed key in a destructuring pattern', ['const { [key]: value } = source;', 'post(value); // FINDING'], 'DESTRUCTURING_NOT_STATIC'],
  ])('stops at %s', async (_name, source, reason) => {
    const witness = await flowOf(source);
    expect(witness.status).toBe('INCOMPLETE');
    expect(witness.unresolved.map((item) => item.reason)).toContain(reason);
  });

  it('marks a property of an object that is assigned again as probable, not confirmed', async () => {
    const witness = await flowOf(['let box = { token: process.env.T };', 'box = other();', 'post(box.token); // FINDING']);
    expect(witness.edges.find((edge) => edge.kind === 'PROPERTY_READ')).toMatchObject({ evidence: 'PROBABLE' });
    expect(witness.status).toBe('INCOMPLETE');
  });

  it('uses the same flows for TARGET and LINK paths', async () => {
    const files: Files = {
      'index.js': lines("const https = require('https');", "const cfg = { net: { host: 'https://example.test' }, unused: load() };", 'const { token } = { token: process.env.T };', 'https.request(cfg.net.host, { headers: { token } }); // FINDING'),
    };
    const index = await indexOf(files);
    const paths = buildActionPaths(index, { artifactId: ARTIFACT, filePath: 'index.js' }, { startLine: 4, endLine: 4 }, { groupId: 'G1', findingId: 'F1', behavior: 'NETWORK_SEND' }, ['TARGET', 'LINK']);
    const lineSet = (context: ContextCode) => paths.find((path) => path.context === context)!.statements.map((item) => item.startLine).sort();
    expect(paths.every((path) => path.complete)).toBe(true);
    expect(lineSet('TARGET')).toEqual([2, 4]);
    expect(lineSet('LINK')).toEqual([2, 3]);
    expect(paths.find((path) => path.context === 'TARGET')!.steps).toEqual([expect.objectContaining({ kind: 'PROPERTY_READ', evidence: 'CONFIRMED', basis: 'PROPERTY_READ' })]);
    const dynamic: Files = { 'index.js': lines("const https = require('https');", 'https.request(cfg[which].host); // FINDING') };
    const stopped = buildActionPaths(await indexOf(dynamic), { artifactId: ARTIFACT, filePath: 'index.js' }, { startLine: 2, endLine: 2 }, { groupId: 'G1', findingId: 'F1', behavior: 'NETWORK_SEND' }, ['TARGET']);
    expect(stopped[0]).toMatchObject({ complete: false, failureReason: 'DYNAMIC_DISPATCH' });
  });
});

describe('program index: package entry points and lifecycle commands', () => {
  const read = (command: string, scripts: Record<string, string> = {}) => readLifecycleCommand(command, scripts);

  it.each([
    ['node install.js', ['install.js']],
    ['node ./scripts/a.js && node scripts/b.js', ['scripts/a.js', 'scripts/b.js']],
    ['node a.js; node b.js', ['a.js', 'b.js']],
    ['NODE_ENV=production node --no-warnings setup.js --flag value', ['setup.js']],
    ['cd scripts && node run.js', ['scripts/run.js']],
    ['node -r ./preload.js main.js', ['preload.js', 'main.js']],
    ['npm run build', ['build.js']],
    ['npm run-script build && node after.js', ['build.js', 'after.js']],
  ])('reads `%s` as a static chain', (command, files) => {
    expect(read(command, { build: 'node build.js' })).toEqual({ files, notStatic: false });
  });

  it.each([
    ['echo install.js', []],
    ['node a.js || node b.js', ['a.js']],
    ['cat list.txt | node reader.js', []],
    ['node $SCRIPT', []],
    ['node "$(pick).js"', []],
    ['node `pick`.js', []],
    ['node -e "require(\'./a.js\')"', []],
    ['sh run.sh', []],
    ['bash -c "node a.js"', []],
    ['npm run missing', []],
    ['npm run loop', []],
    ['node scripts/*.js', []],
  ])('does not follow what `%s` leaves to the shell', (command, files) => {
    expect(read(command, { loop: 'npm run loop' })).toEqual({ files, notStatic: true });
  });

  it('roots the lifecycle chain, `module`, `bin`, `exports` and the default index file', async () => {
    const files: Files = {
      'package.json': JSON.stringify({ name: 'x', module: 'esm/entry.mjs', scripts: { postinstall: 'cd tools && node first.js && npm run later', later: 'node tools/second.js', other: 'node never.js' } }),
      'tools/first.js': 'one(); // FIRST\n', 'tools/second.js': 'two(); // SECOND\n', 'never.js': 'no(); // NEVER\n', 'esm/entry.mjs': 'three(); // MODULE\n', 'index.js': 'four(); // INDEX\n',
      'cli.js': 'five(); // BIN\n', 'lib/api.js': 'six(); // EXPORTS\n',
    };
    const context: Context = {
      lifecycleScripts: [{ name: 'postinstall', command: 'cd tools && node first.js && npm run later', location: null }],
      entryPoints: [{ type: 'BIN', value: 'cli.js', location: null }],
    };
    const index = await indexOf(files, context);
    expect(index.roots.map((root) => `${root.kind} ${root.name} ${root.filePath}`).sort()).toEqual([
      'ENTRY_POINT BIN cli.js', 'ENTRY_POINT MAIN index.js', 'ENTRY_POINT MODULE esm/entry.mjs', 'LIFECYCLE postinstall tools/first.js', 'LIFECYCLE postinstall tools/second.js',
      'SCRIPT later tools/second.js', 'SCRIPT other never.js',
    ]);
    expect(index.limitations).not.toContain('LIFECYCLE_COMMAND_NOT_STATIC');
    const witness = (file: string) => findTriggerWitness(index, { artifactId: ARTIFACT, filePath: file }, { startLine: 1, endLine: 1 });
    expect(witness('tools/second.js')).toMatchObject({ status: 'CONFIRMED', root: { kind: 'LIFECYCLE', name: 'postinstall' } });
    expect(witness('esm/entry.mjs')).toMatchObject({ status: 'CONFIRMED', root: { kind: 'ENTRY_POINT', name: 'MODULE' } });
    // A file only another npm script runs starts at that script.
    expect(witness('never.js')).toMatchObject({ status: 'CONFIRMED', root: { kind: 'SCRIPT', name: 'other' } });

    // With `main` or `exports` the index file is not assumed, and a shell-dependent command roots nothing.
    const explicit = await indexOf({ ...files, 'package.json': JSON.stringify({ main: 'lib/api.js' }) }, { lifecycleScripts: [{ name: 'postinstall', command: 'node $X || node never.js', location: null }], entryPoints: [{ type: 'MAIN', value: 'lib/api.js', location: null }] });
    expect(explicit.roots.map((root) => `${root.kind} ${root.name} ${root.filePath}`)).toEqual(['ENTRY_POINT MAIN lib/api.js']);
    expect(explicit.limitations).toContain('LIFECYCLE_COMMAND_NOT_STATIC');
  });
});

describe('program index: last property assignment', () => {
  const flowOf = async (source: string[]) => (await inputOf({ 'index.js': lines(...source) }, 'index.js')).witness;
  const writes = (witness: { edges: Array<{ kind: string; evidence: string; from?: { startLine: number }; unresolvedReason?: string }> }) => witness.edges
    .filter((edge) => edge.kind === 'PROPERTY_WRITE' || edge.kind === 'PROPERTY_READ').map((edge) => `${edge.kind} ${edge.from?.startLine} ${edge.evidence}${edge.unresolvedReason ? ` ${edge.unresolvedReason}` : ''}`);

  it('takes the last assignment that has always run before the use as the only source', async () => {
    const witness = await flowOf(["const box = { token: 'old' };", 'box.token = first();', 'box.token = process.env.T;', 'post(box.token); // FINDING', 'box.token = later();']);
    expect(writes(witness)).toEqual(['PROPERTY_WRITE 3 CONFIRMED']);
    expect(witness.status).toBe('COMPLETE');
  });

  it.each([
    ['the object is handed to an unknown function in between', ['const box = {};', 'box.token = process.env.T;', 'mutate(box);', 'post(box.token); // FINDING'], ['PROPERTY_WRITE 2 PROBABLE OBJECT_ESCAPED']],
    ['the two branches assign different values', ['const box = {};', 'if (flag) {', '  box.token = process.env.A;', '} else {', '  box.token = process.env.B;', '}', 'post(box.token); // FINDING'],
      ['PROPERTY_WRITE 3 PROBABLE WRITE_ON_SOME_PATHS', 'PROPERTY_WRITE 5 PROBABLE WRITE_ON_SOME_PATHS']],
    ['only one branch assigns', ["const box = { token: 'x' };", 'if (flag) box.token = process.env.A;', 'post(box.token); // FINDING'], ['PROPERTY_WRITE 2 PROBABLE WRITE_ON_SOME_PATHS', 'PROPERTY_READ 1 PROBABLE']],
    ['the assignment is in a loop', ["const box = { token: 'x' };", 'for (const item of list) box.token = item;', 'post(box.token); // FINDING'], ['PROPERTY_WRITE 2 PROBABLE WRITE_ON_SOME_PATHS', 'PROPERTY_READ 1 PROBABLE']],
    ['the assignment is in another function that is not shown to run first', ["const box = { token: 'x' };", 'function set() {', '  box.token = process.env.T;', '}', 'post(box.token); // FINDING'],
      ['PROPERTY_WRITE 3 PROBABLE WRITE_IN_ANOTHER_FUNCTION', 'PROPERTY_READ 1 PROBABLE']],
  ])('keeps it probable when %s', async (_name, source, expected) => {
    const witness = await flowOf(source);
    expect(writes(witness)).toEqual(expected);
    expect(witness.status).toBe('INCOMPLETE');
  });

  it('confirms branches that assign the same value, a write made through a called function, and a harmless hand-over', async () => {
    const same = await flowOf(['const box = {};', 'if (flag) {', '  box.token = process.env.T;', '} else {', '  box.token = process.env.T;', '}', 'post(box.token); // FINDING']);
    expect(writes(same)).toEqual(['PROPERTY_WRITE 3 CONFIRMED']);
    expect(same.status).toBe('COMPLETE');
    const called = await flowOf(["const box = { token: 'x' };", 'function set() {', '  box.token = process.env.T;', '}', 'set();', 'post(box.token); // FINDING']);
    expect(writes(called)).toEqual(['PROPERTY_WRITE 3 CONFIRMED']);
    const logged = await flowOf(['const box = {};', 'box.token = process.env.T;', 'console.log(box);', 'JSON.stringify(box);', 'post(box.token); // FINDING']);
    expect(writes(logged)).toEqual(['PROPERTY_WRITE 2 CONFIRMED']);
    // An assignment after the use, or on the branch the use is not on, is not a source.
    const other = await flowOf(["const box = { token: process.env.T };", 'if (flag) {', '  box.token = other();', '} else {', '  post(box.token); // FINDING', '}']);
    expect(writes(other)).toEqual(['PROPERTY_READ 1 CONFIRMED']);
  });

  it('applies to TARGET and LINK paths', async () => {
    const files: Files = { 'index.js': lines("const https = require('https');", "const opts = { host: 'old' };", 'opts.host = process.env.HOST;', 'leak(opts);', 'https.request(opts.host); // FINDING') };
    const index = await indexOf(files);
    const [target, link] = buildActionPaths(index, { artifactId: ARTIFACT, filePath: 'index.js' }, { startLine: 5, endLine: 5 }, { groupId: 'G1', findingId: 'F1', behavior: 'NETWORK_SEND' }, ['TARGET', 'LINK']);
    for (const path of [target!, link!]) expect(path).toMatchObject({ complete: true, probableEdgeCount: 1, confirmedEdgeCount: 0 });
    expect(target!.statements.map((item) => item.startLine)).toEqual([3, 5]);
  });
});

describe('program index: static computed keys', () => {
  const flowOf = async (source: string[]) => (await inputOf({ 'index.js': lines(...source) }, 'index.js')).witness;

  it.each([
    ['a string literal', ["const box = { token: process.env.T, other: load() };", "post(box['token']); // FINDING"]],
    ['a number literal', ['const parts = [process.env.T, load()];', 'post(parts[0]); // FINDING']],
    ['a template literal without substitutions', ['const box = { token: process.env.T, other: load() };', 'post(box[`token`]); // FINDING']],
    ['a const bound once to a literal', ["const KEY = 'token';", 'const box = { [KEY]: process.env.T, other: load() };', 'post(box[KEY]); // FINDING']],
    ['a const key on the write and a name on the read', ["const KEY = 'token';", 'const box = {};', 'box[KEY] = process.env.T;', 'post(box.token); // FINDING']],
    ['a const key in a destructuring pattern', ["const KEY = 'token';", 'const { [KEY]: value } = { token: process.env.T, other: load() };', 'post(value); // FINDING']],
  ])('follows a property under %s like a named one', async (_name, source) => {
    const witness = await flowOf(source);
    expect({ status: witness.status, unresolved: witness.unresolved.map((item) => item.reason) }).toEqual({ status: 'COMPLETE', unresolved: [] });
  });

  it.each([
    ['a let key', ["let key = 'token';", 'const box = { token: 1 };', 'post(box[key]); // FINDING']],
    ['a key that is assigned again', ["var key = 'token';", "key = 'other';", 'const box = { token: 1 };', 'post(box[key]); // FINDING']],
    ['a parameter key', ['function read(key) {', '  const box = { token: 1 };', '  post(box[key]); // FINDING', '}', "read('token');"]],
    ['a key that is computed', ["const A = 'to';", "const B = 'ken';", 'const box = { token: 1 };', 'post(box[A + B]); // FINDING']],
    ['a template key with a substitution', ["const P = 'to';", 'const box = { token: 1 };', 'post(box[`${P}ken`]); // FINDING']],
    ['a const bound to a call', ['const KEY = pick();', 'const box = { token: 1 };', 'post(box[KEY]); // FINDING']],
  ])('leaves %s unresolved', async (_name, source) => {
    const witness = await flowOf(source);
    expect(witness.status).toBe('INCOMPLETE');
    expect(witness.unresolved.map((item) => item.reason)).toContain('COMPUTED_PROPERTY');
  });
});

describe('program index: known asynchronous callbacks', () => {
  const stepOf = async (source: string[]) => {
    const { witness } = await trigger({ 'index.js': lines(...source) }, 'index.js');
    return { witness, step: witness.steps.find((item) => item.kind === 'CALLBACK')! };
  };
  const body = ['  use(1); // FINDING', '});'];

  it.each([
    ['queueMicrotask', ['queueMicrotask(() => {', ...body], 'QUEUE_MICROTASK'],
    ['process.nextTick', ['process.nextTick(() => {', ...body], 'PROCESS_NEXT_TICK'],
    ['Promise.resolve().then', ['Promise.resolve().then(() => {', ...body], 'PROMISE_RESOLVE_THEN'],
  ])('records %s as scheduled, and as run only because nothing can stop it', async (_name, source, basis) => {
    const { witness, step } = await stepOf(source);
    expect(step).toMatchObject({ evidence: 'CONFIRMED_ASYNC', callbackKind: 'PROMISE_MICROTASK', asyncBoundary: true, basis });
    expect(step.registeredAt).toMatchObject({ startLine: 1 });
    expect(step.executedAt).toBeUndefined();
    expect(witness).toMatchObject({ status: 'CONFIRMED', evidence: 'CONFIRMED_ASYNC', asyncBoundary: true });
    const stopped = await stepOf([...source, 'process.exit(0);']);
    expect(stopped.step).toMatchObject({ evidence: 'PROBABLE', asyncBoundary: true });
    expect(stopped.witness).toMatchObject({ status: 'CONFIRMED', evidence: 'PROBABLE' });
  });

  it.each([
    ['fs.readFile', ["const fs = require('fs');", "fs.readFile('a', (error, data) => {", ...body], 'FS_CALLBACK'],
    ['a destructured fs function', ["const { writeFile } = require('node:fs');", "writeFile('a', 'b', () => {", ...body], 'FS_CALLBACK'],
    ['child_process.exec', ["const { exec } = require('child_process');", "exec('ls', (error, out) => {", ...body], 'CHILD_PROCESS_CALLBACK'],
    ['child_process.execFile through an alias', ["const cp = require('child_process');", 'const run = cp.execFile;', "run('ls', [], () => {", ...body], 'CHILD_PROCESS_CALLBACK'],
  ])('records the callback of %s as scheduled and probable', async (_name, source, basis) => {
    const { witness, step } = await stepOf(source);
    expect(step).toMatchObject({ evidence: 'PROBABLE', callbackKind: 'EXTERNAL_EVENT_CALLBACK', asyncBoundary: true, basis });
    expect(step.registeredAt).toBeDefined();
    expect(step.executedAt).toBeUndefined();
    expect(witness).toMatchObject({ status: 'CONFIRMED', evidence: 'PROBABLE', probableEdgeCount: 1 });
  });

  it.each([
    ['a shadowed queueMicrotask', ['const queueMicrotask = pick();', 'queueMicrotask(() => {', ...body], 'UNKNOWN_CALLBACK'],
    ['an fs whose origin is not shown', ['const fs = pick();', "fs.readFile('a', () => {", ...body], 'UNKNOWN_CALLBACK'],
    ['a file of the package named fs', ["const fs = require('./fs');", "fs.readFile('a', () => {", ...body], 'UNKNOWN_CALLBACK'],
    ['fs.watch', ["const fs = require('fs');", "fs.watch('a', () => {", ...body], 'EXTERNAL_EVENT_CALLBACK'],
    ['setTimeout', ['setTimeout(() => {', '  use(1); // FINDING', '}, 0);'], 'TIMER_CALLBACK'],
    ['setImmediate', ['setImmediate(() => {', ...body], 'TIMER_CALLBACK'],
    ['a network callback', ["const https = require('https');", 'https.get(url, () => {', ...body], 'EXTERNAL_EVENT_CALLBACK'],
  ])('takes the callback of %s as registered and run when it fires', async (_name, source, kind) => {
    const { witness, step } = await stepOf(source);
    expect(step).toMatchObject({ evidence: 'CONFIRMED_ASYNC', callbackKind: kind });
    expect(step.basis).toMatch(/^REGISTERED_CALLBACK:/u);
    expect(witness.status).toBe('CONFIRMED');
  });

  it('tells a callback that runs within the call from one that is only scheduled', async () => {
    const sync = await stepOf(["['a'].forEach(() => {", ...body]);
    expect(sync.step).toMatchObject({ asyncBoundary: false, evidence: 'CONFIRMED' });
    expect(sync.step.executedAt).toBeDefined();
    const scheduled = await stepOf(['queueMicrotask(() => {', ...body]);
    expect(scheduled.step).toMatchObject({ asyncBoundary: true });
    expect(scheduled.step.executedAt).toBeUndefined();
  });
});

describe('program index: alternative witness paths', () => {
  const target = { groupId: 'G1', findingId: 'F1', behavior: 'NETWORK_SEND' as const };
  const pathsAt = async (files: Files, contexts: ContextCode[] = ['ACTION', 'TARGET', 'LINK']) => {
    const line = lineOf(files, 'index.js', 'FINDING');
    return buildActionPaths(await indexOf(files), { artifactId: ARTIFACT, filePath: 'index.js' }, { startLine: line, endLine: line }, target, contexts);
  };

  it('removes semantically identical complete action paths before selection', async () => {
    const files: Files = {
      'index.js': lines(
        "const https = require('https');", 'function send() {', "  Promise.all([https.get('https://a.test'), https.get('https://b.test')]);", '}',
        'send(); // FINDING',
      ),
    };
    const paths = await pathsAt(files);
    expect(paths.filter((path) => path.context === 'ACTION')).toHaveLength(1);
    expect(paths.filter((path) => path.context === 'TARGET')).toHaveLength(1);
    expect(paths.filter((path) => path.context === 'LINK')).toHaveLength(1);
  });

  it('reuses an identical structural query without leaking the first Finding metadata or mutations', async () => {
    const files: Files = { 'index.js': lines("const https = require('https');", "https.get('https://example.test'); // FINDING") };
    const index = await indexOf(files);
    const line = lineOf(files, 'index.js', 'FINDING');
    const at = [{ artifactId: ARTIFACT, filePath: 'index.js' }, { startLine: line, endLine: line }] as const;
    const first = buildActionPaths(index, ...at, target, ['ACTION']);
    first[0]!.outcome = 'ADDED';
    const second = buildActionPaths(index, ...at, { ...target, findingId: 'F2' }, ['ACTION']);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ findingId: 'F2', pathId: '', outcome: 'NOT_NEEDED' });
    expect(second[0]).not.toBe(first[0]);
  });

  it('returns every root a Finding is reached from, best first, and keeps the single witness as the best one', async () => {
    const files: Files = {
      'index.js': lines("const { run } = require('./lib');", 'run();'),
      'main.js': lines("const { run } = require('./lib');", 'run();'),
      'lib.js': lines("const https = require('https');", 'exports.run = function run() {', "  https.get('https://example.test'); // FINDING", '};'),
    };
    const context: Context = { ...postinstall(), entryPoints: [{ type: 'MAIN', value: 'main.js', location: null }] };
    const index = await indexOf(files, context);
    const at = [index, { artifactId: ARTIFACT, filePath: 'lib.js' }, { startLine: 3, endLine: 3 }] as const;
    const witnesses = findTriggerWitnesses(...at);
    expect(witnesses.map((witness) => `${witness.root?.kind} ${witness.root?.filePath} ${witness.status}`)).toEqual(['LIFECYCLE index.js CONFIRMED', 'ENTRY_POINT main.js CONFIRMED']);
    expect(findTriggerWitness(...at)).toEqual(witnesses[0]);
    expect(sites(witnesses[1]!)).toEqual(['main.js:2', 'main.js:1', 'lib.js:2', 'lib.js:3']);
  });

  it('gives one witness that starts at a function nothing refers to', async () => {
    const files: Files = { 'index.js': '1;\n', 'lib.js': lines('function unused() {', '  fetch(1); // FINDING', '}') };
    const witnesses = findTriggerWitnesses(await indexOf(files), { artifactId: ARTIFACT, filePath: 'lib.js' }, { startLine: 2, endLine: 2 });
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0]).toMatchObject({ status: 'CONFIRMED', steps: [], root: { kind: 'UNREFERENCED', name: 'unused' } });
  });

  it('gives one ACTION, TARGET and LINK path per operation call the Finding leads to', async () => {
    const files: Files = {
      'index.js': lines(
        "const https = require('https');", "const HOST = 'https://example.test';", 'function probe(url) {', '  https.get(url);', '}',
        'function post(url, body) {', '  https.request(url).end(body);', '}', 'function both(url) {', '  probe(url);', "  post(url, 'x');", '}', 'both(HOST); // FINDING',
      ),
    };
    const paths = await pathsAt(files);
    const of = (context: ContextCode) => paths.filter((path) => path.context === context);
    expect(of('ACTION').map((path) => `${path.sink?.callee} ${path.sink?.filePath}:${path.sink?.startLine} depth=${path.depth} complete=${path.complete}`))
      .toEqual(['https.get index.js:4 depth=2 complete=true', 'https.request index.js:7 depth=2 complete=true']);
    expect(of('TARGET').map((path) => path.sink?.startLine)).toEqual([4, 7]);
    expect(of('LINK').map((path) => path.sink?.startLine)).toEqual([4, 7]);
    expect(of('TARGET').every((path) => path.complete && path.statements.some((item) => item.startLine === 2))).toBe(true);
    // Each path ends at its own sink and does not hold the other one.
    expect(of('ACTION')[0]!.statements.some((item) => item.startLine === 7)).toBe(false);
    expect(of('ACTION')[1]!.statements.some((item) => item.startLine === 4)).toBe(false);
  });

  it('lists a sink statement once', async () => {
    const wrappers = [1, 2, 3, 4, 5, 6].flatMap((n) => [`function w${n}(url) {`, `  https.get(url + ${n});`, '}']);
    const files: Files = {
      'index.js': lines("const https = require('https');", ...wrappers, 'function all(url) {', '  w1(url); w1(url); w2(url); w3(url); w4(url); w5(url); w6(url);', '}', "all('https://example.test'); // FINDING"),
    };
    const actions = await pathsAt(files, ['ACTION']);
    expect(actions.map((path) => path.sink?.startLine)).toEqual([3, 6, 9, 12, 15, 18]);
  });

  it('reports one failed path per context when no operation call is found', async () => {
    const files: Files = { 'index.js': lines('function noop(value) {', '  return value;', '}', 'noop(1); // FINDING') };
    const paths = await pathsAt(files);
    expect(paths.map((path) => `${path.context} ${path.complete} ${path.failureReason}`)).toEqual(['ACTION false NO_COMPLETE_PATH', 'TARGET false NO_COMPLETE_PATH', 'LINK false NO_COMPLETE_PATH']);
    expect(paths.every((path) => path.sink === undefined)).toBe(true);
  });
});

describe('program index: classes', () => {
  const DAEMON = (...body: string[]) => lines('class Daemon {', ...body, '}', 'new Daemon().start();');
  const send = ['  send() {', '    post(1); // FINDING', '  }'];
  const reach = async (source: string, context: Context = postinstall()) => (await trigger({ 'index.js': source }, 'index.js', 'FINDING', context)).witness;

  it('takes this.method() in an instance method as that method of the class', async () => {
    const witness = await reach(DAEMON('  start() {', '    this.send();', '  }', ...send));
    expect(witness).toMatchObject({ status: 'CONFIRMED', evidence: 'CONFIRMED', probableEdgeCount: 0, root: { kind: 'LIFECYCLE' } });
    expect(witness.steps.map((step) => step.basis)).toEqual(['STATIC_CALLEE', 'STATIC_CALLEE']);
  });

  it('reads this inside an arrow function as the this of the method around it, and inside a function as unknown', async () => {
    const arrow = await reach(DAEMON('  start() {', '    [1].forEach(() => this.send());', '  }', ...send));
    expect(arrow).toMatchObject({ status: 'CONFIRMED', probableEdgeCount: 0 });
    expect(arrow.steps.map((step) => step.basis)).not.toContain('NAME_MATCH');
    const own = await reach(DAEMON('  start() {', '    [1].forEach(function () { this.send(); });', '  }', ...send));
    expect(own.steps.some((step) => step.basis === 'NAME_MATCH' && step.evidence === 'PROBABLE')).toBe(true);
  });

  it('keeps the call probable when a subclass may stand in, the method is handed over on its own, or the method is static', async () => {
    const extended = await reach(lines('class Daemon {', '  start() {', '    this.send();', '  }', ...send, '}', 'class Quiet extends Daemon {', '  send() {}', '}', 'new Daemon().start();'));
    expect(extended).toMatchObject({ status: 'CONFIRMED', evidence: 'PROBABLE', probableEdgeCount: 1 });
    const detached = await reach(lines('class Daemon {', '  start() {', '    this.send();', '  }', ...send, '}', 'const daemon = new Daemon();', "process.on('exit', daemon.start);", 'daemon.start();'));
    expect(detached).toMatchObject({ evidence: 'PROBABLE', probableEdgeCount: 1 });
    // A bound method keeps its receiver.
    const bound = await reach(lines('class Daemon {', '  start() {', '    this.send();', '  }', ...send, '}', 'const daemon = new Daemon();', "process.on('exit', daemon.start.bind(daemon));", 'daemon.start();'));
    expect(bound).toMatchObject({ evidence: 'CONFIRMED', probableEdgeCount: 0 });
    const fixed = await reach(lines('class Daemon {', '  static start() {', '    this.send();', '  }', '  static send() {', '    post(1); // FINDING', '  }', '}', 'Daemon.start();'));
    expect(fixed.probableEdgeCount).toBeGreaterThan(0);
  });

  it('keeps a method of a class that itself extends another confirmed', async () => {
    const witness = await reach(lines("const { EventEmitter } = require('events');", 'class Daemon extends EventEmitter {', '  start() {', '    this.send();', '  }', ...send, '}', 'new Daemon().start();'));
    expect(witness).toMatchObject({ status: 'CONFIRMED', evidence: 'CONFIRMED', probableEdgeCount: 0 });
  });

  describe('exported starts', () => {
    const lib = async (source: string, extra: Files = {}) => (await trigger({ 'index.js': lines("require('./lib');"), 'lib.js': source, ...extra }, 'lib.js')).witness;

    it('adds the class line and the export statement to a path that starts at a method of an exported class', async () => {
      const witness = await lib(lines('class Client {', '  constructor() {}', ...send, '}', '', 'module.exports = Client;'));
      expect(witness).toMatchObject({ status: 'CONFIRMED', steps: [], root: { kind: 'EXPORTED_API', name: 'Client.send' } });
      expect(sites(witness)).toEqual(['lib.js:8', 'lib.js:1', 'lib.js:4']);
    });

    it('cuts an export statement that holds the whole class or object down to its opening line', async () => {
      expect(sites(await lib(lines('module.exports = class Client', '{', ...send, '};')))).toEqual(['lib.js:1-2', 'lib.js:4']);
      expect(sites(await lib(lines('export class Client {', ...send, '}')))).toEqual(['lib.js:1', 'lib.js:3']);
      expect(sites(await lib(lines('module.exports = {', ...send, '};')))).toEqual(['lib.js:1', 'lib.js:3']);
    });

    it('adds the export statement of an exported function, and the statement that passes it on from another file', async () => {
      expect(sites(await lib(lines('function send() {', '  post(1); // FINDING', '}', 'exports.send = send;')))).toEqual(['lib.js:4', 'lib.js:2']);
      expect(sites(await lib(lines('exports.send = function () {', '  post(1); // FINDING', '};')))).toEqual(['lib.js:1', 'lib.js:2']);
    });

    it('leaves out a declaration on a very long line and says so', async () => {
      const witness = await lib(lines(`class Client { /* ${'x'.repeat(320)} */`, ...send, '}', 'module.exports = Client;'));
      expect(sites(witness)).toEqual(['lib.js:6', 'lib.js:3']);
      expect(witness.limitations).toContain('EXPORT_STATEMENT_TOO_LONG');
      const oneLine = await lib(lines(`class Client { send() { post(1); /* FINDING ${'x'.repeat(320)} */ } }`, 'module.exports = Client;'));
      expect(sites(oneLine)).toEqual(['lib.js:2', 'lib.js:1']);
      expect(oneLine.limitations).not.toContain('EXPORT_STATEMENT_TOO_LONG');
    });

    it('adds nothing to a path that starts at code nothing exports', async () => {
      const witness = await lib(lines('class Client {', ...send, '}'));
      expect(witness.root).toMatchObject({ kind: 'UNREFERENCED' });
      expect(sites(witness)).toEqual(['lib.js:3']);
    });
  });

  describe('fields', () => {
    const flow = (witness: { edges: Array<{ kind: string; from?: { startLine: number }; to: { startLine: number }; name?: string }> }): string[] => (
      witness.edges.map((edge) => `${edge.kind} ${edge.name ?? ''} ${edge.from?.startLine ?? '-'} -> ${edge.to.startLine}`)
    );
    const input = async (...body: string[]) => (await inputOf({ 'index.js': lines('class Daemon {', ...body, '}', 'new Daemon().run();') }, 'index.js')).witness;

    it('follows a field written in one place to what was put there', async () => {
      const witness = await input('  constructor() {', '    this.lockFile = process.env.LOCK;', '  }', '  run() {', '    post(this.lockFile); // FINDING', '  }');
      expect(witness.status).toBe('COMPLETE');
      expect(flow(witness)).toEqual(['ASSIGNMENT this.lockFile 3 -> 6']);
      expect(witness.probableEdgeCount).toBe(0);
      const declared = await input('  lockFile = process.env.LOCK;', '  run() {', '    post(this.lockFile); // FINDING', '  }');
      expect(declared.status).toBe('COMPLETE');
      const nested = await input('  constructor() {', '    this.paths = { lock: process.env.LOCK };', '  }', '  run() {', '    post(this.paths.lock); // FINDING', '  }');
      expect(nested.status).toBe('COMPLETE');
    });

    it.each([
      ['is written in two places', ['  constructor() {', '    this.lockFile = process.env.LOCK;', '  }', '  reset() {', "    this.lockFile = 'x';", '  }']],
      ['is never written', []],
      ['may be written under a computed name', ['  constructor(name) {', '    this.lockFile = process.env.LOCK;', '    this[name] = 1;', '  }']],
      ['may be written by Object.assign', ['  constructor(options) {', '    this.lockFile = process.env.LOCK;', '    Object.assign(this, options);', '  }']],
      ['is updated in place', ['  constructor() {', '    this.lockFile = process.env.LOCK;', '  }', '  bump() {', '    this.lockFile += 1;', '  }']],
    ])('leaves a field that %s unresolved', async (_name, body) => {
      const witness = await input(...body, '  run() {', '    post(this.lockFile); // FINDING', '  }');
      expect(witness.status).toBe('INCOMPLETE');
      expect(witness.unresolved.map((item) => item.reason)).toContain('THIS_PROPERTY');
    });

    it('leaves a field of a class with a parent or a subclass unresolved', async () => {
      const child = (await inputOf({ 'index.js': lines('class Base {}', 'class Daemon extends Base {', '  constructor() {', '    super();', '    this.lockFile = process.env.LOCK;', '  }', '  run() {', '    post(this.lockFile); // FINDING', '  }', '}', 'new Daemon().run();') }, 'index.js')).witness;
      expect(child.unresolved.map((item) => item.reason)).toContain('THIS_PROPERTY');
      const parent = (await inputOf({ 'index.js': lines('class Daemon {', '  constructor() {', '    this.lockFile = process.env.LOCK;', '  }', '  run() {', '    post(this.lockFile); // FINDING', '  }', '}', 'class Other extends Daemon {}', 'new Daemon().run();') }, 'index.js')).witness;
      expect(parent.unresolved.map((item) => item.reason)).toContain('THIS_PROPERTY');
    });

    it('calls through a field that holds a module or an object of the package', async () => {
      const files: Files = { 'index.js': lines("const https = require('https');", 'class Daemon {', '  constructor() {', '    this.client = https;', '  }', '  start() {', "    this.client.get('https://example.test'); // FINDING", '  }', '}', 'new Daemon().start();') };
      const index = await indexOf(files);
      const line = lineOf(files, 'index.js', 'FINDING');
      const paths = buildActionPaths(index, { artifactId: ARTIFACT, filePath: 'index.js' }, { startLine: line, endLine: line }, { groupId: 'G1', findingId: 'F1', behavior: 'NETWORK_SEND' }, ['ACTION']);
      expect(paths.find((path) => path.context === 'ACTION')).toMatchObject({ complete: true, probableEdgeCount: 0, sink: { startLine: line } });
    });
  });
});

describe('program index: code as packages ship it', () => {
  const AWAITER = 'var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) { return new (P || (P = Promise))(function (resolve) { resolve((generator = generator.apply(thisArg, _arguments || [])).next()); }); };';
  const actions = async (files: Files, behavior: BehaviorGroup = 'NETWORK_SEND') => {
    const line = lineOf(files, 'index.js', 'FINDING');
    return buildActionPaths(await indexOf(files), { artifactId: ARTIFACT, filePath: 'index.js' }, { startLine: line, endLine: line }, { groupId: 'G1', findingId: 'F1', behavior }, ['ACTION']);
  };

  it('indexes a CommonJS file that uses a strict-mode reserved word as a name or returns at the top level', async () => {
    const files: Files = { 'index.js': lines("const package = require('./package.json');", 'if (!package.name) return;', "fetch('https://example.test'); // FINDING") };
    const { index, witness } = await trigger(files, 'index.js');
    expect(index.parseFailures).toEqual([]);
    expect(index.files.find((file) => file.filePath === 'index.js')!.parsed).toBe(true);
    expect(witness.status).toBe('CONFIRMED');
  });

  it('still leaves out a file whose syntax is broken in any mode', async () => {
    const files: Files = { 'index.js': lines('const a = ;', 'fetch(1); // FINDING') };
    const { index, witness } = await trigger(files, 'index.js');
    expect(index.parseFailures.map((item) => item.filePath)).toEqual(['index.js']);
    expect(witness).toMatchObject({ status: 'INCOMPLETE', incomplete: { reason: 'FILE_NOT_INDEXED' } });
  });

  it('follows the compiled form of a call to an imported function', async () => {
    const files: Files = {
      'index.js': lines("const lib_1 = require('./lib');", '(0, lib_1.run)();'),
      'lib.js': lines('exports.run = function run() {', '  fetch(1); // FINDING', '};'),
    };
    const { witness } = await trigger(files, 'lib.js');
    expect(witness.status).toBe('CONFIRMED');
    expect(witness.steps.map((step) => `${step.kind} ${step.site.filePath}:${step.site.startLine}`)).toEqual(['CALL index.js:2']);
    // Anything but a literal in front of the comma may do something first, so that form is not read.
    const other = await trigger({ ...files, 'index.js': lines("const lib_1 = require('./lib');", '(prepare(), lib_1.run)();') }, 'lib.js');
    expect(other.witness).toMatchObject({ steps: [], root: { kind: 'EXPORTED_API', name: 'run' } });
  });

  it('takes the body handed to the compiler async helper as run by the call', async () => {
    const body = ['function main() {', '  return __awaiter(this, void 0, void 0, function* () {', '    fetch(1); // FINDING', '  });', '}', 'main();'];
    const { witness } = await trigger({ 'index.js': lines(AWAITER, ...body) }, 'index.js');
    expect(witness.status).toBe('CONFIRMED');
    expect(witness.steps.map((step) => `${step.kind} ${step.basis}`)).toEqual(['CALL STATIC_CALLEE', 'CALLBACK COMPILER_ASYNC_HELPER']);
  });

  it('does not read a function that only bears the helper name as the helper', async () => {
    const body = ['function main() {', '  return __awaiter(this, void 0, void 0, function* () {', '    fetch(1); // FINDING', '  });', '}', 'main();'];
    const keeps = 'var __awaiter = function (thisArg, _arguments, P, generator) { pending.push(generator); };';
    const basisOf = async (source: string[]) => (await trigger({ 'index.js': lines(...source) }, 'index.js')).witness.steps.find((step) => step.kind === 'CALLBACK')?.basis;
    expect(await basisOf([keeps, ...body])).toBe('REGISTERED_CALLBACK:CALLBACK_PASSED_ON');
    // The generator has to be the argument the helper calls.
    const wrongSlot = ['function main() {', '  return __awaiter(function* () {', '    fetch(1); // FINDING', '  });', '}', 'main();'];
    expect(await basisOf([AWAITER, ...wrongSlot])).not.toBe('COMPILER_ASYNC_HELPER');
  });

  it('finds a method a class of the package inherits', async () => {
    const files: Files = {
      'index.js': lines("const { Child } = require('./child');", 'new Child().send();'),
      'child.js': lines("const { Base } = require('./base');", 'class Child extends Base {}', 'exports.Child = Child;'),
      'base.js': lines('class Base {', '  send() {', '    fetch(1); // FINDING', '  }', '}', 'exports.Base = Base;'),
    };
    expect((await trigger(files, 'base.js')).witness.status).toBe('CONFIRMED');
    const outside = { ...files, 'child.js': lines("const { Base } = require('some-dependency');", 'class Child extends Base {}', 'exports.Child = Child;') };
    // With a parent from a dependency the method is only matched by its name.
    const matched = (await trigger(outside, 'base.js')).witness;
    expect(matched).toMatchObject({ status: 'CONFIRMED', evidence: 'PROBABLE' });
    expect(matched.steps.at(-1)).toMatchObject({ basis: 'NAME_MATCH' });
  });

  it('takes ACTION from a Finding on a declaration to the operation calls that use the declared name', async () => {
    const files: Files = {
      'index.js': lines("const https = require('https'); // FINDING", 'function probe(url) {', '  https.get(url);', '}', 'function post(url) {', "  https.request(url).end('x');", '}', 'console.log(https);'),
    };
    const paths = await actions(files);
    expect(paths.map((path) => `${path.complete} ${path.sink?.callee}@${path.sink?.startLine} ${path.steps.map((step) => `${step.kind}/${step.basis}`).join(',')}`))
      .toEqual(['true https.get@3 REFERENCE/DECLARED_NAME_USED', 'true https.request@6 REFERENCE/DECLARED_NAME_USED']);
    expect(paths[0]!.statements).toEqual([expect.objectContaining({ startLine: 3, endLine: 3 })]);
    const constant: Files = { 'index.js': lines("const ENDPOINT = 'https://example.test'; // FINDING", 'function send() {', '  fetch(ENDPOINT);', '}') };
    expect((await actions(constant)).map((path) => `${path.complete} ${path.sink?.callee}@${path.sink?.startLine}`)).toEqual(['true fetch@3']);
  });

  it('finds no ACTION when the declared name is never used in an operation call or may have been reassigned', async () => {
    const unused: Files = { 'index.js': lines("const https = require('https'); // FINDING", 'console.log(https.globalAgent);') };
    expect((await actions(unused)).map((path) => `${path.complete} ${path.failureReason}`)).toEqual(['false NO_COMPLETE_PATH']);
    const reassigned: Files = { 'index.js': lines("let endpoint = 'https://example.test'; // FINDING", 'endpoint = input;', 'fetch(endpoint);') };
    expect((await actions(reassigned)).map((path) => `${path.complete} ${path.failureReason}`)).toEqual(['false NO_COMPLETE_PATH']);
  });
});
