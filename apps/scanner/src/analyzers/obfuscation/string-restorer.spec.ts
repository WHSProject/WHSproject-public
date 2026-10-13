import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import { restoreStrings } from './string-restorer';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default
  ?? _traverse) as typeof _traverse;
const parseStrict = (source: string) => parse(source, { sourceType: 'unambiguous', errorRecovery: false });

function callArguments(source: string, name: string): t.Node[][] {
  const calls: t.Node[][] = [];
  traverse(parseStrict(source), {
    CallExpression(path) {
      if (t.isIdentifier(path.node.callee, { name })) calls.push(path.node.arguments);
    },
  });
  return calls;
}

describe('string restoration binding preservation', () => {
  it('keeps identically named constants in separate scopes independent', () => {
    const result = restoreStrings(`
      function first() { const text = 'first'; record(text); }
      function second() { const text = 'second'; record(text); }
    `);
    expect(callArguments(result.code, 'record')).toMatchObject([
      [{ type: 'StringLiteral', value: 'first' }],
      [{ type: 'StringLiteral', value: 'second' }],
    ]);
  });

  it('does not substitute a constant into a shadowing function parameter or decoder argument', () => {
    const result = restoreStrings(`
      const encoded = 'aGk=';
      function decode(encoded) { record(encoded); return atob(encoded); }
      record(atob(encoded));
    `);
    expect(callArguments(result.code, 'atob')).toMatchObject([[{ type: 'Identifier', name: 'encoded' }]]);
    expect(callArguments(result.code, 'record')).toMatchObject([
      [{ type: 'Identifier', name: 'encoded' }], [{ type: 'StringLiteral', value: 'hi' }],
    ]);
  });

  it('does not use a different function local for an unbound identifier', () => {
    const result = restoreStrings(`
      function local() { const encoded = 'aGk='; record(encoded); }
      function external() { return atob(encoded); }
    `);
    expect(callArguments(result.code, 'atob')).toMatchObject([[{ type: 'Identifier', name: 'encoded' }]]);
  });

  it('resolves decoder arguments against their own lexical bindings', () => {
    const result = restoreStrings(`
      function first() { const encoded = 'b25l'; record(atob(encoded)); }
      function second() { const encoded = 'dHdv'; record(atob(encoded)); }
    `);
    expect(callArguments(result.code, 'record')).toMatchObject([
      [{ type: 'StringLiteral', value: 'one' }], [{ type: 'StringLiteral', value: 'two' }],
    ]);
  });

  it.each([
    'decodeURIComponent(encoded)',
    'unescape(encoded)',
    "Buffer.from(encoded, 'base64')",
    'eval(encoded)',
  ])('does not bypass binding lookup through %s', (expression) => {
    const result = restoreStrings(`const encoded = 'aGk='; function shadow(encoded) { ${expression}; }`);
    expect(result.code).toContain(expression);
    expect(result.changed).toBe(false);
    expect(result.payloads).toEqual([]);
  });

  it('keeps nested block bindings separate, including empty strings', () => {
    const result = restoreStrings("const text = ''; { const text = 'inner'; record(text); } record(text);");
    expect(callArguments(result.code, 'record')).toMatchObject([
      [{ type: 'StringLiteral', value: 'inner' }], [{ type: 'StringLiteral', value: '' }],
    ]);
  });

  it('does not report an export-only constant as a supported transform', () => {
    const result = restoreStrings("const name = 'label'; export { name };");
    expect(() => parseStrict(result.code)).not.toThrow();
    expect(result.changed).toBe(false);
    expect(result.transformations).toEqual([]);
  });

  it.each([
    'value++; record(value);',
    '++value; record(value);',
    'value += 1; record(value);',
    'value = 2; record(value);',
    'for (value in input) { record(value); }',
    'for (value of input) { record(value); }',
    '[value] = input; record(value);',
    '({ value } = input); record(value);',
  ])('preserves mutable binding and write positions: %s', (operation) => {
    const result = restoreStrings(`
      function constant() { const value = 'label'; record(value); }
      function mutable(input) { let value = 0; ${operation} }
    `);
    expect(() => parseStrict(result.code)).not.toThrow();
    expect(callArguments(result.code, 'record')).toMatchObject([
      [{ type: 'StringLiteral', value: 'label' }], [{ type: 'Identifier', name: 'value' }],
    ]);
  });

  it('preserves export specifier identifiers while folding ordinary reads', () => {
    const result = restoreStrings("const name = 'label'; record(name); export { name, name as alias };");
    const ast = parseStrict(result.code);
    const exported = ast.program.body.find((node) => t.isExportNamedDeclaration(node));
    expect(exported).toMatchObject({
      specifiers: [
        { local: { type: 'Identifier', name: 'name' }, exported: { type: 'Identifier', name: 'name' } },
        { local: { type: 'Identifier', name: 'name' }, exported: { type: 'Identifier', name: 'alias' } },
      ],
    });
    expect(callArguments(result.code, 'record')).toMatchObject([[{ type: 'StringLiteral', value: 'label' }]]);
  });

  it('preserves re-export identifiers from another module', () => {
    const result = restoreStrings("const name = 'local'; export { name as remote } from './module.js'; record(name);");
    expect(parseStrict(result.code).program.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'ExportNamedDeclaration', specifiers: [expect.objectContaining({
        local: expect.objectContaining({ type: 'Identifier', name: 'name' }),
      })] }),
    ]));
  });

  it('retains property names when expanding an object shorthand read', () => {
    const result = restoreStrings("const name = 'label'; record({ name });");
    expect(callArguments(result.code, 'record')).toMatchObject([[{
      type: 'ObjectExpression', properties: [{
        key: { type: 'Identifier', name: 'name' }, value: { type: 'StringLiteral', value: 'label' },
      }],
    }]]);
  });

  it('continues supported multi-round literal decoding without losing line mapping', () => {
    const result = restoreStrings("const encoded = Buffer.from('aGk=', 'base64').toString(); record(encoded);");
    expect(callArguments(result.code, 'record')).toMatchObject([[{ type: 'StringLiteral', value: 'hi' }]]);
    expect(result.transformations).toEqual(expect.arrayContaining(['BASE64_BUFFER', 'CONST_INLINE']));
    expect(result.lineMapping.status).toBe('MAPPED');
  });
});
