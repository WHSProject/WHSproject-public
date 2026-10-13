import type { LocationLineageStatus } from '../../domain/analysis.types';
import {
  SOURCE_LINE_MAPPING_VERSION,
  type SourceLineMapping,
  type SourceLineMappingEntry,
} from './obfuscation.types';

interface BabelSourceMapLike {
  mappings?: string;
}

export interface MappedLineRange {
  lineageStatus: Extract<LocationLineageStatus, 'MAPPED' | 'UNMAPPED'>;
  derivedFrom: {
    path: string;
    startLine?: number;
    endLine?: number;
  };
}

export function identityLineMapping(
  path: string,
  code: string,
): SourceLineMapping {
  const lineCount = countLines(code);
  const entries = Array.from({ length: lineCount }, (_, index) => ({
    derivedLine: index + 1,
    sourceLine: index + 1,
    confidence: 'EXACT' as const,
  }));
  return {
    version: SOURCE_LINE_MAPPING_VERSION,
    sourcePath: path,
    derivedPath: path,
    status: lineCount === 0 ? 'UNMAPPED' : 'MAPPED',
    entries,
    derivedLineCount: lineCount,
    mappedLineCount: entries.length,
    limitations: [],
  };
}

export function payloadLineMapping(
  sourcePath: string,
  derivedPath: string,
  sourceLine: number | null,
  code: string,
): SourceLineMapping {
  if (sourceLine === null) {
    return createMapping(
      sourcePath,
      derivedPath,
      countLines(code),
      [],
      ['PAYLOAD_SOURCE_LINE_UNAVAILABLE', 'LINE_MAPPING_UNMAPPED'],
    );
  }
  return createMapping(
    sourcePath,
    derivedPath,
    countLines(code),
    Array.from({ length: countLines(code) }, (_, index) => ({
      derivedLine: index + 1,
      sourceLine,
      confidence: 'APPROXIMATE' as const,
    })),
    [],
  );
}

/**
 * Converts Babel's generated-code source map into the compact line contract
 * used by Tier 2. Babel can leave generated helper lines without a source
 * segment; those lines remain explicitly unmapped instead of being guessed.
 */
export function babelLineMapping(
  sourcePath: string,
  derivedPath: string,
  sourceCode: string,
  derivedCode: string,
  sourceMap: BabelSourceMapLike | null | undefined,
): SourceLineMapping {
  if (sourceCode === derivedCode) return identityLineMapping(sourcePath, derivedCode);
  const entries = sourceMap?.mappings === undefined
    ? []
    : decodeBabelMappings(sourceMap.mappings);
  const derivedLineCount = countLines(derivedCode);
  const unique = uniqueEntries(entries.filter(({ derivedLine }) => derivedLine <= derivedLineCount));
  const limitations: string[] = [];
  if (sourceMap?.mappings === undefined) limitations.push('BABEL_SOURCE_MAP_UNAVAILABLE');
  if (unique.length < derivedLineCount) limitations.push('LINE_MAPPING_INCOMPLETE');
  return createMapping(sourcePath, derivedPath, derivedLineCount, unique, limitations);
}

/**
 * Webcrack 2.16 exposes transformed code but not a source map. Exact line
 * anchors are retained where a normalized line is unique; all other lines are
 * intentionally left unmapped and carry a limitation for Tier 3.
 */
export function anchorLineMapping(
  sourcePath: string,
  derivedPath: string,
  sourceCode: string,
  derivedCode: string,
): SourceLineMapping {
  if (sourceCode === derivedCode) return identityLineMapping(sourcePath, derivedCode);
  const sourceLines = splitLines(sourceCode);
  const derivedLines = splitLines(derivedCode);
  const sourceBySignature = new Map<string, number[]>();
  for (const [index, line] of sourceLines.entries()) {
    const signature = lineSignature(line);
    if (signature === '') continue;
    const values = sourceBySignature.get(signature) ?? [];
    values.push(index + 1);
    sourceBySignature.set(signature, values);
  }
  const entries: SourceLineMappingEntry[] = [];
  for (const [index, line] of derivedLines.entries()) {
    const signature = lineSignature(line);
    const candidates = signature === '' ? undefined : sourceBySignature.get(signature);
    if (candidates?.length === 1) {
      entries.push({ derivedLine: index + 1, sourceLine: candidates[0]!, confidence: 'EXACT' });
    }
  }
  const limitations = entries.length < derivedLines.length
    ? ['WEBCRACK_SOURCE_MAP_UNAVAILABLE', 'LINE_MAPPING_INCOMPLETE']
    : [];
  return createMapping(sourcePath, derivedPath, derivedLines.length, entries, limitations);
}

/** Composes `current -> previous` with `previous -> original`. */
export function composeLineMappings(
  currentToPrevious: SourceLineMapping,
  previousToOriginal: SourceLineMapping,
  derivedPath = currentToPrevious.derivedPath,
): SourceLineMapping {
  const previousEntries = new Map(
    previousToOriginal.entries.map((entry) => [entry.derivedLine, entry]),
  );
  const entries: SourceLineMappingEntry[] = [];
  let dropped = false;
  for (const entry of currentToPrevious.entries) {
    const original = previousEntries.get(entry.sourceLine);
    if (original === undefined) {
      dropped = true;
      continue;
    }
    entries.push({
      derivedLine: entry.derivedLine,
      sourceLine: original.sourceLine,
      confidence: entry.confidence === 'APPROXIMATE' || original.confidence === 'APPROXIMATE'
        ? 'APPROXIMATE'
        : 'EXACT',
    });
  }
  const limitations = [...new Set([
    ...previousToOriginal.limitations,
    ...currentToPrevious.limitations,
    ...(dropped ? ['LINE_MAPPING_COMPOSITION_INCOMPLETE'] : []),
  ])];
  return createMapping(
    previousToOriginal.sourcePath,
    derivedPath,
    currentToPrevious.derivedLineCount,
    uniqueEntries(entries),
    limitations,
  );
}

export function mapDerivedLineRange(
  mapping: SourceLineMapping | undefined,
  sourcePath: string,
  startLine: number | undefined,
  endLine: number | undefined,
): MappedLineRange {
  if (mapping === undefined || startLine === undefined) {
    return { lineageStatus: 'UNMAPPED', derivedFrom: { path: sourcePath } };
  }
  const effectiveEnd = endLine ?? startLine;
  const byDerived = new Map(mapping.entries.map((entry) => [entry.derivedLine, entry]));
  const sourceLines: number[] = [];
  for (let line = startLine; line <= effectiveEnd; line += 1) {
    const entry = byDerived.get(line);
    if (entry === undefined) {
      return { lineageStatus: 'UNMAPPED', derivedFrom: { path: sourcePath } };
    }
    sourceLines.push(entry.sourceLine);
  }
  return {
    lineageStatus: 'MAPPED',
    derivedFrom: {
      path: sourcePath,
      startLine: Math.min(...sourceLines),
      endLine: Math.max(...sourceLines),
    },
  };
}

export function mappingForPath(
  mappings: readonly SourceLineMapping[] | undefined,
  path: string,
): SourceLineMapping | undefined {
  return mappings?.find((mapping) => mapping.derivedPath === path || mapping.sourcePath === path);
}

function createMapping(
  sourcePath: string,
  derivedPath: string,
  derivedLineCount: number,
  entries: SourceLineMappingEntry[],
  limitations: readonly string[],
): SourceLineMapping {
  const unique = uniqueEntries(entries);
  return {
    version: SOURCE_LINE_MAPPING_VERSION,
    sourcePath,
    derivedPath,
    status: unique.length > 0 ? 'MAPPED' : 'UNMAPPED',
    entries: unique,
    derivedLineCount,
    mappedLineCount: unique.length,
    limitations: [...new Set(limitations)],
  };
}

function countLines(code: string): number {
  return splitLines(code).length;
}

function splitLines(code: string): string[] {
  return code.length === 0 ? [] : code.split(/\r\n|\n|\r/u);
}

function lineSignature(line: string): string {
  return line
    .replace(/\/\*[^]*?\*\//gu, '')
    .replace(/\/\/.*$/u, '')
    .match(/[A-Za-z_$][\w$]*|0x[0-9a-f]+|\d+(?:\.\d+)?|(?:===|!==|=>|&&|\|\||\+\+|--|[{}()[\].,;:+\-*/=<>!?])/gu)
    ?.join('') ?? '';
}

function uniqueEntries(entries: readonly SourceLineMappingEntry[]): SourceLineMappingEntry[] {
  const byLine = new Map<number, SourceLineMappingEntry>();
  for (const entry of entries) {
    if (!byLine.has(entry.derivedLine)) byLine.set(entry.derivedLine, entry);
  }
  return [...byLine.values()].sort((left, right) => left.derivedLine - right.derivedLine);
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBabelMappings(mappings: string): SourceLineMappingEntry[] {
  const entries: SourceLineMappingEntry[] = [];
  let sourceIndex = 0;
  let sourceLine = 0;
  for (const [lineIndex, line] of mappings.split(';').entries()) {
    let generatedColumn = 0;
    for (const segment of line.split(',')) {
      if (segment === '') continue;
      const values = decodeVlq(segment);
      if (values.length < 4) continue;
      generatedColumn += values[0]!;
      sourceIndex += values[1]!;
      sourceLine += values[2]!;
      // A line-level contract intentionally ignores generated/source columns.
      if (sourceIndex >= 0 && sourceLine >= 0 && generatedColumn >= 0) {
        entries.push({ derivedLine: lineIndex + 1, sourceLine: sourceLine + 1, confidence: 'EXACT' });
      }
    }
  }
  return entries;
}

function decodeVlq(value: string): number[] {
  const result: number[] = [];
  let current = 0;
  let shift = 0;
  for (const character of value) {
    const digit = BASE64.indexOf(character);
    if (digit < 0) return [];
    const continuation = (digit & 32) !== 0;
    current += (digit & 31) << shift;
    if (!continuation) {
      const negative = (current & 1) === 1;
      result.push((current >> 1) * (negative ? -1 : 1));
      current = 0;
      shift = 0;
    } else {
      shift += 5;
    }
  }
  return shift === 0 ? result : [];
}
