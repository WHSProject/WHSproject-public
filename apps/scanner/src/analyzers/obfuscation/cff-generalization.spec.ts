import { runInNewContext } from 'node:vm';
import { countHelperDefinitions, countHelperCallSites, reduceBinaryHelpers } from './helper-analysis';
import { detect } from './detector';
import { hasStaticOrderDispatch, restoreStaticOrderDispatch } from './static-order-dispatch';
import { restoreStructure } from './structure-restorer';
import { structuralFingerprint } from './structure-quality';

// Only authored harmless programs are evaluated. No dataset or package code is executed.
const evaluate = (source: string): string => JSON.stringify(runInNewContext(source, {}, { timeout: 100 }));
const dispatch = (head = 'while (true)') => `
  var order = [2, 0, 1]; var cursor = 0; var result = [];
  ${head} { switch(order[cursor++]) {
    case 0: result.push('middle'); continue;
    case 1: result.push('end'); continue;
    case 2: result.push('begin'); continue;
  } break; } result;`;

describe('CFF structural generalization and restoration', () => {
  it.each(['while (true)', 'while (!![])', 'while (!0)', 'while (1)', 'for (;;)', 'for (;true;)'])(
    'detects and restores static dispatch independent of loop spelling: %s', (head) => {
      const source = dispatch(head);
      expect(detect('arbitrary.js', source).structuralCandidate).toBe(true);
      const result = restoreStaticOrderDispatch(source);
      expect(result.flattened).toBe(1);
      expect(hasStaticOrderDispatch(result.code)).toBe(false);
      expect(evaluate(result.code)).toBe(evaluate(source));
    },
  );

  it.each([
    ['lexical cross-case binding', dispatch().replace("result.push('begin');", 'let value = 1;')],
    ['nested break', dispatch().replace("result.push('begin');", 'if (result.length) break;')],
    ['nested continue', dispatch().replace("result.push('begin');", 'if (result.length) continue;')],
    ['function declaration', dispatch().replace("result.push('begin');", 'function f() {}')],
    ['direct eval', dispatch().replace("result.push('begin');", "eval('cursor = 3')")],
    ['label', dispatch().replace('while (true)', 'label: while (true)')],
    ['dynamic order', dispatch().replace('[2, 0, 1]', 'readOrder()')],
    ['order mutation', dispatch().replace('while (true)', 'order.reverse(); while (true)')],
  ])('does not rewrite unsupported %s', (_name, source) => {
    expect(restoreStaticOrderDispatch(source)).toEqual({ code: source, flattened: 0 });
  });

  it('restores static dispatch without a string-array decoder through the real wrapper', async () => {
    const result = await restoreStructure(dispatch());
    expect(result.status).toBe('COMPLETED');
    expect(result.diagnostics).toMatchObject({ dispatchersFlattened: 1, staticDispatchBefore: true, staticDispatchAfter: false });
    expect(evaluate(result.code!)).toBe(evaluate(dispatch()));
  });

  it('preserves cursor progress observable by an external callback', () => {
    const source = dispatch().replaceAll('result.push(', 'observe(');
    const compare = (code: string) => {
      const context: Record<string, unknown> = { seen: [] };
      context.observe = (value: string) => (context.seen as unknown[]).push([value, context.cursor]);
      runInNewContext(code, context, { timeout: 100 });
      return JSON.stringify([context.seen, context.cursor]);
    };
    const result = restoreStaticOrderDispatch(source);
    expect(result.flattened).toBe(1);
    expect(compare(result.code)).toBe(compare(source));
  });

  it('does not call formatting-only output a structural change', async () => {
    const result = await restoreStructure("const x={ 'value': 1 };\nx['value'];");
    expect(result.status).toBe('NO_CHANGE');
    expect(result.diagnostics?.syntaxChanged).toBe(false);
  });

  it('fingerprints ignore comments, quoted keys, raw numeric and string spellings', () => {
    expect(structuralFingerprint("var o={'x':0x10};o['x']; // note"))
      .toBe(structuralFingerprint('var o = {x: 16}; o.x;'));
  });
});

describe('helper syntax and conservative binary reduction', () => {
  it.each(["'add'", '"add"', 'add'])('counts %s identically and does not promote a normal utility', (name) => {
    const source = `var ops = { ${name}: function(a,b) { return a+b; } }; ops.add(1,2);`;
    expect(countHelperDefinitions(source)).toBe(1);
    expect(detect('utility.js', source).obfuscated).toBe(false);
    const result = reduceBinaryHelpers(source);
    expect(result.replacements).toBe(1);
    expect(countHelperCallSites(result.code)).toBe(0);
    expect(countHelperDefinitions(result.code)).toBe(1); // Retained definition is not a remaining call.
    expect(evaluate(result.code)).toBe(evaluate(source));
  });

  it('does not count code-shaped text inside comments or strings', () => {
    const source = `var text = "'add': function(a,b){return a+b;}"; /* 'mul': function(a,b){return a*b;} */`;
    expect(countHelperDefinitions(source)).toBe(0);
  });

  it('does not classify generated export getters as forwarding helpers', () => {
    const source = Array.from({ length: 5 }, (_, i) =>
      `Object.defineProperty(exports,'key${i}',{get:function(){return imported.value;}});`).join('\n');
    expect(countHelperDefinitions(source)).toBe(0);
    expect(detect('exports.js', source).obfuscated).toBe(false);
  });

  it.each(['+', '-', '*', '/', '%', '===', '!=', '<', '**'])('preserves eager operator %s', (op) => {
    const source = `var x = { op: function(a,b){return a ${op} b;} }; x.op(4,2);`;
    const result = reduceBinaryHelpers(source);
    expect(result.replacements).toBe(1);
    expect(evaluate(result.code)).toBe(evaluate(source));
  });

  it('preserves argument evaluation and coercion order', () => {
    const source = `var trace=[]; var ops={add:function(a,b){return a+b;}};
      function left(){trace.push('left');return {valueOf(){trace.push('coerce');return 3;}};}
      function right(){trace.push('right');return 4;}
      var answer=ops.add(left(),right()); [answer,trace];`;
    const result = reduceBinaryHelpers(source);
    expect(result.replacements).toBe(1);
    expect(evaluate(result.code)).toBe(evaluate(source));
  });

  it('preserves thrown argument behavior', () => {
    const source = `var trace=[];var ops={add:function(a,b){return a+b;}};
      function fail(){trace.push('fail');throw new Error('expected');}
      try {ops.add(fail(),trace.push('wrong'));}catch(e){trace.push(e.message);} trace;`;
    expect(evaluate(reduceBinaryHelpers(source).code)).toBe(evaluate(source));
  });

  const unsafe = [
    'var o={f:function(a,b){return b+a;}}; o.f(1,2);',
    'var o={f:function(a,b){return a&&b;}}; o.f(1,2);',
    'var o={f:function(a,b){return a(b);}}; o.f(fn,2);',
    'var o={f:function(a,b){return a+a;}}; o.f(1,2);',
    'var o={f:function(a,b){return a+b;}}; o.f=other; o.f(1,2);',
    'var o={f:function(a,b){return a+b;}}; consume(o); o.f(1,2);',
    'var o={f:function(a,b){return a+b;}}; o[key](1,2);',
    'var o={f:function(a,b){return a+b;}}; o.f(...args);',
    'var o={f:function(a,b){return a+b;}}; function later(){return o.f(1,2);}',
    'var o={get f(){return fn;}}; o.f(1,2);',
    'var o={f:function(a,b){return a+b;}}; delete o.f; o.f(1,2);',
    'var o={f:function(a,b){return a+b;}}; eval(text); o.f(1,2);',
    'var o={f:function(a,b){return a+b;},f:other}; o.f(1,2);',
    'var o={__proto__:parent,f:function(a,b){return a+b;}}; o.f(1,2);',
  ];
  it.each(unsafe)('leaves unsupported program unchanged: %s', (source) => {
    expect(reduceBinaryHelpers(source)).toEqual({ code: source, replacements: 0 });
  });
});
