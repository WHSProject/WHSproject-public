import { Script } from 'node:vm';
import { parse } from '@babel/parser';
import { restoreStrings } from './string-restorer';

interface Fixture {
  name: string;
  source: string;
  records: string[];
  error?: string;
}

// Only execute the harmless, repository-authored fixtures below. node:vm is NOT
// a security sandbox: never feed package samples, files, or downloaded code here.
function observe(source: string): { records: string[]; error?: string } {
  const records: string[] = [];
  try {
    new Script(source).runInNewContext({
      Buffer, atob,
      record: (...values: unknown[]) => { records.push(JSON.stringify(values)); },
    }, { timeout: 200 });
    return { records };
  } catch (error) {
    return { records, error: (error as Error).name };
  }
}

const fixtures: Fixture[] = [
  { name: 'ordinary multi-round Buffer decoding', source: "const x = Buffer.from('aGk=', 'base64').toString(); record(x);", records: ['["hi"]'] },
  { name: 'Buffer value retains its type and indexing', source: "const x = Buffer.from('6869', 'hex'); record(Buffer.isBuffer(x), x[0], x.length);", records: ['[true,104,2]'] },
  { name: 'Buffer output encoding is respected', source: "record(Buffer.from('aGk=', 'base64').toString('hex'));", records: ['["6869"]'] },
  { name: 'Buffer slicing arguments are preserved', source: "record(Buffer.from('aGk=', 'base64').toString('utf8', 1));", records: ['["i"]'] },
  { name: 'computed Buffer methods', source: "record(Buffer['from']('6869', 'hex')['toString']('utf8'));", records: ['["hi"]'] },
  { name: 'Buffer input argument side effect', source: "record(Buffer.from('aGk=', 'base64', record('extra')).toString());", records: ['["extra"]', '["hi"]'] },
  { name: 'Buffer output argument side effect', source: "record(Buffer.from('aGk=', 'base64').toString(record('encoding')));", records: ['["encoding"]', '["hi"]'] },
  { name: 'string toString argument side effect', source: "record('hi'.toString(record('extra')));", records: ['["extra"]', '["hi"]'] },
  { name: 'atob returns binary Latin-1, not UTF-8', source: "const x = atob('/w=='); record(x.charCodeAt(0));", records: ['[255]'] },
  { name: 'atob rejects malformed padding', source: "record(atob('a'));", records: [], error: 'InvalidCharacterError' },
  { name: 'atob argument side effect', source: "record(atob('aGk=', record('extra')));", records: ['["extra"]', '["hi"]'] },
  { name: 'URI argument side effect', source: "record(decodeURIComponent('%41', record('extra')));", records: ['["extra"]', '["A"]'] },
  { name: 'unescape argument side effect', source: "record(unescape('%41', record('extra')));", records: ['["extra"]', '["A"]'] },
  { name: 'malformed URI exception', source: "record(decodeURIComponent('%'));", records: [], error: 'URIError' },
  { name: 'shadowed atob', source: "function f(atob) { record(atob('aGk=')); } f(() => 'local');", records: ['["local"]'] },
  { name: 'shadowed URI decoder', source: "function f(decodeURIComponent) { record(decodeURIComponent('%41')); } f(() => 'local');", records: ['["local"]'] },
  { name: 'shadowed unescape', source: "function f(unescape) { record(unescape('%41')); } f(() => 'local');", records: ['["local"]'] },
  { name: 'shadowed Buffer', source: "function f(Buffer) { record(Buffer.from('aGk=', 'base64').toString()); } f({ from: () => ({ toString: () => 'local' }) });", records: ['["local"]'] },
  { name: 'shadowed String', source: "function f(String) { record(String.fromCharCode(65)); } f({ fromCharCode: () => 'local' });", records: ['["local"]'] },
  { name: 'shadowed eval', source: "function f(eval) { eval(\"record('decoded')\"); } f(() => record('local'));", records: ['["local"]'] },
  { name: 'tagged template retains raw and cooked arrays', source: 'function tag(parts) { return parts.raw[0]; } record(tag`hello`);', records: ['["hello"]'] },
  { name: 'invalid cooked escape in tagged template', source: 'function tag(parts) { return parts[0] === undefined; } record(tag`\\unicode`);', records: ['[true]'] },
  { name: 'const temporal dead zone', source: "record(x); const x = 'later';", records: [], error: 'ReferenceError' },
  { name: 'var read before initialization', source: "record(typeof x); var x = 'later';", records: ['["undefined"]'] },
  { name: 'closure called before initialization', source: "function f() { record(x); } f(); const x = 'later';", records: [], error: 'ReferenceError' },
  { name: 'conditional var initialization', source: "if (false) { var x = 'later'; } record(typeof x);", records: ['["undefined"]'] },
  { name: 'decoder argument before initialization', source: "record(atob(x)); const x = 'aGk=';", records: [], error: 'ReferenceError' },
  { name: 'eval preserves lexical scope', source: "eval(\"const x = 'inside'; record(x);\"); record(typeof x);", records: ['["inside"]', '["undefined"]'] },
  { name: 'eval strict directive does not leak var', source: "eval(\"'use strict'; var x = 'inside';\"); record(typeof x);", records: ['["undefined"]'] },
  { name: 'eval argument side effect', source: "eval(\"record('decoded')\", record('extra'));", records: ['["extra"]', '["decoded"]'] },
  { name: 'eval can modify a binding invisible to static analysis', source: "let x = 'before'; eval(\"x = 'after'\"); record(x);", records: ['["after"]'] },
  { name: 'with dynamic name resolution', source: "const x = 'outer'; with ({ x: 'inner' }) { record(x); }", records: ['["inner"]'] },
  { name: 'with dynamic decoder resolution', source: "with ({ atob: () => 'local' }) { record(atob('aGk=')); }", records: ['["local"]'] },
  { name: 'ordinary supported decoders', source: "record(atob('aGk='), decodeURIComponent('%41'), unescape('%42'), String['fromCharCode'](67));", records: ['["hi","A","B","C"]'] },
  { name: 'ordinary concatenation and template', source: "const x = `hi`; record(x + '!');", records: ['["hi!"]'] },
  { name: 'ordinary expression eval payload', source: "eval(\"record('hello')\");", records: ['["hello"]'] },
  { name: 'folding must not create a strict-mode directive', source: "function f() { 'use ' + 'strict'; record(this === undefined); } f();", records: ['[false]'] },
  { name: 'template folding must not create a strict-mode directive', source: "function f() { `use strict`; record(this === undefined); } f();", records: ['[false]'] },
  { name: 'hoisted function default argument before initialization', source: "f(); const x = 'later'; function f(value = x) { record(value); }", records: [], error: 'ReferenceError' },
  { name: 'ordered declarators', source: "const x = 'aGk=', y = atob(x); record(y);", records: ['["hi"]'] },
  { name: 'unordered declarators retain temporal dead zone', source: "const x = atob(y), y = 'aGk='; record(x);", records: [], error: 'ReferenceError' },
  { name: 'eval inherits strict-mode syntax restrictions', source: "'use strict'; eval('record(010)');", records: [], error: 'SyntaxError' },
];

describe('string restoration semantics (trusted fixtures only)', () => {
  it.each(fixtures)('$name', ({ source, records, error }) => {
    const expected = error === undefined ? { records } : { records, error };
    // Check expectations against the original too: a broken fixture cannot pass
    // just because original and restored both fail in the same way.
    expect(observe(source)).toEqual(expected);
    const restored = restoreStrings(source);
    expect(() => parse(restored.code, { sourceType: 'script', errorRecovery: false })).not.toThrow();
    expect(observe(restored.code)).toEqual(expected);
    expect(observe(restoreStrings(restored.code).code)).toEqual(expected);
  });
});
