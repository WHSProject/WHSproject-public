// Offline, paired-source audit. Does not import the production detector or execute samples.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import * as t from '@babel/types';

const traverse = traverseModule.default ?? traverseModule;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ignored = new Set(['start', 'end', 'loc', 'extra', 'leadingComments',
  'innerComments', 'trailingComments', 'comments', 'tokens', 'errors']);

// Deliberately no statement deletion, inlining, reordering, or general constant folding.
export function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (!node || typeof node !== 'object') return node;
  if (t.isUnaryExpression(node, { operator: '!' })
    && t.isUnaryExpression(node.argument, { operator: '!' })
    && t.isArrayExpression(node.argument.argument)
    && node.argument.argument.elements.length === 0) return { type: 'BooleanLiteral', value: true };
  const out = Object.fromEntries(Object.entries(node).filter(([key]) => !ignored.has(key))
    .map(([key, value]) => [key, normalize(value)]));
  if (out.type === 'MemberExpression' && out.computed
    && out.property.type === 'StringLiteral' && t.isValidIdentifier(out.property.value)) {
    out.computed = false;
    out.property = { type: 'Identifier', name: out.property.value };
  }
  return out;
}

const keyName = (member) => member.computed
  ? (t.isStringLiteral(member.property) ? member.property.value : null)
  : (t.isIdentifier(member.property) ? member.property.name : null);
const propertyName = (prop) => !prop.computed && t.isIdentifier(prop.key)
  ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;

// Read literal order tables, including tables stored in local helper objects. No evaluation.
function literalValue(node, scope, depth = 0) {
  if (!node || depth > 8) return undefined;
  if (t.isStringLiteral(node) || t.isNumericLiteral(node)) return node.value;
  if (t.isArrayExpression(node)) {
    const values = node.elements.map((n) => literalValue(n, scope, depth + 1));
    return values.every((v) => typeof v === 'string' || typeof v === 'number') ? values : undefined;
  }
  if (t.isIdentifier(node)) {
    const binding = scope.getBinding(node.name);
    return binding?.path.isVariableDeclarator()
      ? literalValue(binding.path.node.init, binding.path.scope, depth + 1) : undefined;
  }
  if (t.isMemberExpression(node) && t.isIdentifier(node.object)) {
    const binding = scope.getBinding(node.object.name);
    const init = binding?.path.isVariableDeclarator() ? binding.path.node.init : null;
    if (!t.isObjectExpression(init)) return undefined;
    const prop = init.properties.find((p) => t.isObjectProperty(p) && propertyName(p) === keyName(node));
    return prop ? literalValue(prop.value, binding.path.scope, depth + 1) : undefined;
  }
  if (t.isCallExpression(node) && t.isMemberExpression(node.callee)
    && keyName(node.callee) === 'split' && node.arguments.length === 1) {
    const value = literalValue(node.callee.object, scope, depth + 1);
    const separator = literalValue(node.arguments[0], scope, depth + 1);
    if (typeof value === 'string' && typeof separator === 'string') return value.split(separator);
  }
  return undefined;
}

function inspect(ast, source) {
  const helpers = [];
  const switches = [];
  traverse(ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id) || !t.isObjectExpression(path.node.init)) return;
      const binding = path.scope.getBinding(path.node.id.name);
      for (const prop of path.node.init.properties) {
        if (!t.isObjectProperty(prop) || prop.computed || !t.isFunctionExpression(prop.value)) continue;
        const fn = prop.value;
        if (fn.async || fn.generator || !fn.params.length || !fn.params.every((p) => t.isIdentifier(p))
          || fn.body.body.length !== 1 || !t.isReturnStatement(fn.body.body[0])) continue;
        const expr = fn.body.body[0].argument;
        const params = new Set(fn.params.map((p) => p.name));
        const param = (n) => t.isIdentifier(n) && params.has(n.name);
        const operation = (t.isBinaryExpression(expr) || t.isLogicalExpression(expr))
          && param(expr.left) && param(expr.right);
        const call = t.isCallExpression(expr) && param(expr.callee) && expr.arguments.every(param);
        if (!operation && !call) continue;
        const key = propertyName(prop);
        if (key === null) continue;
        const callLines = (binding?.referencePaths ?? []).filter((ref) => {
          const member = ref.parentPath;
          return member.isMemberExpression() && member.node.object === ref.node
            && keyName(member.node) === key && member.parentPath.isCallExpression()
            && member.parentPath.node.callee === member.node;
        }).map((ref) => ref.node.loc.start.line);
        helpers.push({ object: path.node.id.name, key, line: prop.loc.start.line,
          kind: operation ? expr.operator : 'FORWARD_CALL', callLines,
          definition: source.slice(prop.start, prop.end) });
      }
    },
    SwitchStatement(path) {
      const discriminant = path.node.discriminant;
      const loop = path.parentPath.isBlockStatement() ? path.parentPath.parentPath : null;
      const inDirectLoop = Boolean(loop && (loop.isWhileStatement() || loop.isForStatement()));
      const indexedCursor = t.isMemberExpression(discriminant) && discriminant.computed
        && t.isIdentifier(discriminant.object) && t.isUpdateExpression(discriminant.property, { operator: '++' })
        && !discriminant.property.prefix && t.isIdentifier(discriminant.property.argument);
      const tails = path.node.cases.map((c) => c.consequent.at(-1)?.type ?? null);
      const caseValues = path.node.cases.map((c) => c.test?.value ?? null);
      const order = indexedCursor ? literalValue(discriminant.object, path.scope) : undefined;
      const orderKeys = Array.isArray(order) ? order.map(String) : [];
      const caseKeys = caseValues.map(String);
      const reorderedPermutation = orderKeys.length === caseKeys.length
        && new Set(orderKeys).size === caseKeys.length
        && caseKeys.every((key) => orderKeys.includes(key))
        && !isDeepStrictEqual(orderKeys, caseKeys);
      // Evidence classification only, not a safe-to-restore predicate or generic CFF detector.
      const dispatcherShape = inDirectLoop && indexedCursor && path.node.cases.length >= 2
        && path.node.cases.every((c) => t.isStringLiteral(c.test) || t.isNumericLiteral(c.test))
        && tails.every((tail) => tail === 'ContinueStatement' || tail === 'ReturnStatement')
        && reorderedPermutation;
      switches.push({ line: path.node.loc.start.line, inDirectLoop, dispatcherShape,
        discriminant: source.slice(discriminant.start, discriminant.end),
        caseValues, order: order ?? null, reorderedPermutation, tails });
    },
  });
  return { helpers, switches };
}

export function classifyPair(originalSource, obfuscatedSource) {
  const original = parse(originalSource, { sourceType: 'unambiguous', errorRecovery: false });
  const obfuscated = parse(obfuscatedSource, { sourceType: 'unambiguous', errorRecovery: false });
  const equalAfterNormalization = isDeepStrictEqual(normalize(original.program), normalize(obfuscated.program));
  const before = inspect(original, originalSource);
  const after = inspect(obfuscated, obfuscatedSource);
  const introducedDispatcher = before.switches.length === 0 && after.switches.some((s) => s.dispatcherShape);
  const introducedUsedHelper = before.helpers.length === 0 && after.helpers.some((h) => h.callLines.length > 0);
  const classification = equalAfterNormalization ? 'SURFACE_ONLY'
    : introducedDispatcher ? 'DISPATCHER'
      : introducedUsedHelper ? 'HELPER_ONLY' : 'UNRESOLVED';
  return { classification, equalAfterNormalization, introducedDispatcher, introducedUsedHelper, before, after };
}

export async function runAudit(corpusRoot, predictionsPath) {
  const group = join(resolve(corpusRoot), 'control-flow-flattening');
  const names = (await readdir(group)).filter((name) => name.endsWith('.obf.js')).sort();
  assert.equal(names.length, 40, 'Expected the complete fixed 40-file group');
  // Classification is completed for all pairs BEFORE predictions are read or joined.
  const rows = [];
  for (const name of names) {
    const originalBytes = await readFile(join(group, name.replace(/\.obf\.js$/, '.js')));
    const obfuscatedBytes = await readFile(join(group, name));
    rows.push({ path: `control-flow-flattening/${name}`, originalSha256: hash(originalBytes),
      obfuscatedSha256: hash(obfuscatedBytes), ...classifyPair(originalBytes.toString('utf8'), obfuscatedBytes.toString('utf8')) });
  }
  const predictionsBytes = await readFile(predictionsPath);
  const predictions = JSON.parse(predictionsBytes);
  const matching = predictions.rows.filter((r) => r.technique === 'control-flow-flattening');
  assert.equal(matching.length, 40);
  assert.equal(new Set(matching.map((r) => r.path)).size, 40);
  for (const row of rows) {
    const prediction = matching.find((p) => p.path === row.path);
    assert.ok(prediction, `Missing prediction: ${row.path}`);
    assert.equal(prediction.sha256, row.obfuscatedSha256, `Corpus changed: ${row.path}`);
    assert.equal(typeof prediction.before, 'boolean');
    assert.equal(typeof prediction.after, 'boolean');
    row.baselineCandidate = prediction.before;
    row.currentCandidate = prediction.after;
  }
  const summary = {};
  for (const row of rows) {
    const count = summary[row.classification] ??= { files: 0, baselineCandidates: 0, currentCandidates: 0 };
    count.files++;
    count.baselineCandidates += Number(row.baselineCandidate);
    count.currentCandidates += Number(row.currentCandidate);
  }
  return { schemaVersion: 1, measuredAt: new Date().toISOString(), node: process.version,
    method: 'paired-source AST comparison, independent of production detector; observational subclassification',
    runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    predictionsSha256: hash(predictionsBytes), predictionImplementation: predictions.implementation,
    samplesExecuted: false, productionDetectorExecuted: false,
    limitations: ['Retrospective audit of a previously inspected local subset, not blinded external validation.',
      'HELPER_ONLY means introduced used forwarding helpers without a matched dispatcher; not block-level flattening.',
      'DISPATCHER is structural evidence, not semantic equivalence or successful restoration.',
      'SURFACE_ONLY is exact paired AST equality under documented narrow normalization, not a global no-obfuscation claim.',
      'Original hashes are recorded now; no upstream archive hash verification is performed here.',
      'Candidate predictions are rejoined from the saved complete run, not a new scan.'],
    summary, rows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, predictions, output] = process.argv.slice(2);
  if (!root || !predictions || !output) throw new Error('Usage: tier2-cff-paired-audit.mjs CORPUS SAVED_PREDICTIONS NEW_OUTPUT_JSON');
  const result = await runAudit(root, predictions);
  await writeFile(output, JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ summary: result.summary, rows: result.rows.map((r) => ({
    path: r.path, classification: r.classification, baselineCandidate: r.baselineCandidate,
    currentCandidate: r.currentCandidate, originalHelpers: r.before.helpers.length,
    helpers: r.after.helpers.length, originalSwitches: r.before.switches.length,
    switches: r.after.switches.length,
  })) }, null, 2));
}
