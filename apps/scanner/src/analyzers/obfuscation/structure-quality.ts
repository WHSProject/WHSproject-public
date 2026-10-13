import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;
const generate = ((_generate as unknown as { default?: typeof _generate }).default ?? _generate) as typeof _generate;

/** A syntax comparison, NOT a semantic-equivalence proof. Throws on invalid source. */
export function structuralFingerprint(source: string): string {
  const ast = parse(source, { sourceType: 'unambiguous' });
  traverse(ast, {
    enter(p) {
      delete p.node.extra;
      if (t.isMemberExpression(p.node) && p.node.computed && t.isStringLiteral(p.node.property)
        && t.isValidIdentifier(p.node.property.value, false)) {
        p.node.property = t.identifier(p.node.property.value);
        p.node.computed = false;
      }
      if (t.isObjectProperty(p.node) && !p.node.computed && t.isStringLiteral(p.node.key)
        && t.isValidIdentifier(p.node.key.value, false)) p.node.key = t.identifier(p.node.key.value);
    },
  });
  return generate(ast, { comments: false, compact: true }).code;
}
