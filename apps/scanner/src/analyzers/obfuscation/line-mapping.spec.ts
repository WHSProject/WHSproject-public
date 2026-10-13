import { mapDerivedLineRange, anchorLineMapping, composeLineMappings, payloadLineMapping } from './line-mapping';
import { restoreStrings } from './string-restorer';

describe('source-to-deobfuscated line mapping', () => {
  it('emits Babel-backed mappings for the string restore transform', () => {
    const source = [
      "const decoded = Buffer.from('Y29uc29sZS5sb2coJ2hlbGxvJyk7', 'base64').toString();",
      'eval(decoded);',
    ].join('\n');

    const result = restoreStrings(source);

    expect(result.changed).toBe(true);
    expect(result.lineMapping.version).toBe('0.1.0');
    expect(result.lineMapping.status).toBe('MAPPED');
    expect(result.lineMapping.entries.length).toBeGreaterThan(0);
    expect(result.lineMapping.entries.every(({ derivedLine, sourceLine }) => derivedLine > 0 && sourceLine > 0)).toBe(true);
    expect(mapDerivedLineRange(result.lineMapping, 'package/index.js', 1, 1).lineageStatus).toBe('MAPPED');
  });

  it('keeps Webcrack-generated lines explicit when no source map exists', () => {
    const mapping = anchorLineMapping(
      'package/index.js',
      'package/index.js',
      ['const a = 1;', 'console.log(a);'].join('\n'),
      ['const a = 1;', 'console.log(a);', 'generated();'].join('\n'),
    );

    expect(mapping.status).toBe('MAPPED');
    expect(mapping.entries.map(({ derivedLine, sourceLine }) => [derivedLine, sourceLine])).toEqual([[1, 1], [2, 2]]);
    expect(mapping.limitations).toEqual(expect.arrayContaining(['WEBCRACK_SOURCE_MAP_UNAVAILABLE', 'LINE_MAPPING_INCOMPLETE']));
    expect(mapDerivedLineRange(mapping, 'package/index.js', 3, 3)).toEqual({
      lineageStatus: 'UNMAPPED',
      derivedFrom: { path: 'package/index.js' },
    });
  });

  it('composes multi-stage mappings and preserves approximate payload provenance', () => {
    const first = anchorLineMapping('package/index.js', 'package/index.js', 'one\ntwo', 'one\ntwo\nthree');
    const second = payloadLineMapping('package/index.js', 'package/index.js.payload-1.js', 2, 'decoded();');
    const composed = composeLineMappings(second, first, 'package/index.js.payload-1.js');

    expect(composed.sourcePath).toBe('package/index.js');
    expect(composed.derivedPath).toBe('package/index.js.payload-1.js');
    expect(composed.entries).toEqual([{ derivedLine: 1, sourceLine: 2, confidence: 'APPROXIMATE' }]);
    expect(mapDerivedLineRange(composed, 'package/index.js', 1, 1).lineageStatus).toBe('MAPPED');
  });
});
