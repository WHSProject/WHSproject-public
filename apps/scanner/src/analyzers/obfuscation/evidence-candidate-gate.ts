import { promises as fs } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { AnalyzerResult, Finding, FindingLocation } from '../../domain/analysis.types';
import { EvidenceMappingRegistry } from '../../evidence/normalizer/evidence-mapping.registry';
import type { EvidenceSignalType } from '../../evidence/normalizer/evidence-normalizer.types';
import { canonicalizeEvidencePath } from './path-utils';
import type { CapabilityValidation, RestoreResult, RestoreStatus, SourceLineMapping, ValidationSnapshot } from './obfuscation.types';

const DERIVED_ANALYZERS = new Set([
  'custom-rule-deobfuscated',
  'guarddog-deobfuscated',
] as const);

const EVIDENCE_MAPPINGS = new EvidenceMappingRegistry();
const BEHAVIOR_SIGNAL_TYPES = new Set<EvidenceSignalType>([
  'REMOTE_FETCH',
  'CHILD_PROCESS',
  'SHELL_EXEC',
  'DYNAMIC_CODE_EXECUTION',
  'ENV_READ',
  'FILE_READ',
  'FILE_WRITE',
  'FILE_DELETE',
  'AUTOSTART',
  'KEYSTROKE_CAPTURE',
  'SYSTEM_INFO',
  'CREDENTIAL_READ',
  'SECRET_READ',
  'SENSITIVE_FILE_READ',
  'NETWORK_EGRESS',
]);

export type Tier2DerivedAnalyzer = 'custom-rule-deobfuscated' | 'guarddog-deobfuscated';
export type Tier2RestoredStatus = Extract<RestoreStatus, 'RESTORED' | 'PARTIAL_RESTORED'>;

export interface Tier2CandidateContext {
  requestId: string;
  scanId: string;
  artifactHash: string;
}

/**
 * A validated Finding candidate only. This is intentionally not Atomic Evidence
 * and carries no representation, lineage, or analysisPass fields.
 */
export interface Tier2EvidenceCandidate {
  analyzer: Tier2DerivedAnalyzer;
  analyzerVersion: string;
  finding: Finding;
  ruleId: string;
  rawFindingId: string;
  requestId: string;
  scanId: string;
  artifactHash: string;
  path: string;
  paths: string[];
  originalPath: string;
  originalPaths: string[];
  derivedPath: string;
  derivedPaths: string[];
  derivedOutputPath: string;
  derivedOutputPaths: string[];
  restoreStatus: Tier2RestoredStatus;
  /** Source-file locations retained after the candidate gate validated them. */
  locations: FindingLocation[];
  limitations: string[];
  lineMapping?: SourceLineMapping;
  lineMappings?: SourceLineMapping[];
  capabilityPreservation?: CapabilityValidation;
}

interface DerivedFile {
  path: string;
  originalPath: string;
  outputPath: string;
  status: Tier2RestoredStatus;
  lineCount: number;
  limitations: string[];
  lineMapping?: SourceLineMapping;
  validation?: ValidationSnapshot;
}

/**
 * Extracts only validated risk Findings from the deterministic Tier2 rerun.
 * The function deliberately does not call the Evidence Normalizer.
 */
export async function collectTier2EvidenceCandidates(
  derivedResults: AnalyzerResult[],
  restore: RestoreResult,
  context: Tier2CandidateContext,
): Promise<Tier2EvidenceCandidate[]> {
  const derivedFiles = await collectDerivedFiles(restore);
  const filesByPath = new Map(derivedFiles.map((file) => [file.path, file]));
  const candidates: Tier2EvidenceCandidate[] = [];

  for (const result of derivedResults) {
    if (
      !isDerivedAnalyzer(result.analyzer)
      || result.requestId !== context.requestId
      || result.scanId !== context.scanId
    ) continue;

    for (const finding of result.findings) {
      if (!isRiskFinding(result.analyzer, finding)) continue;
      const sourceLocations = getSourceLocations(finding);
      if (sourceLocations === undefined || sourceLocations.length === 0) continue;

      const validatedLocations = sourceLocations.map((location) => {
        const path = safePackageRelativePath(location.path);
        if (path === undefined) return undefined;
        const derivedFile = filesByPath.get(path);
        if (derivedFile === undefined || !isValidLineRange(location, derivedFile.lineCount)) {
          return undefined;
        }
        return { location, path, file: derivedFile };
      });
      if (validatedLocations.some((value) => value === undefined)) continue;

      const validLocations = validatedLocations.filter(
        (value): value is { location: FindingLocation; path: string; file: DerivedFile } => value !== undefined,
      );
      const first = validLocations[0];
      if (first === undefined) continue;
      const paths = validLocations.map(({ path }) => path);
      const originalPaths = validLocations.map(({ file }) => file.originalPath);
      const derivedOutputPaths = validLocations.map(({ file }) => file.outputPath);

      candidates.push({
        analyzer: result.analyzer,
        analyzerVersion: result.analyzerVersion,
        finding,
        ruleId: finding.ruleId,
        rawFindingId: finding.findingId,
        requestId: context.requestId,
        scanId: context.scanId,
        artifactHash: context.artifactHash,
        path: first.path,
        paths,
        originalPath: originalPaths[0] ?? first.file.originalPath,
        originalPaths,
        derivedPath: first.path,
        derivedPaths: paths,
        derivedOutputPath: first.file.outputPath,
        derivedOutputPaths,
        locations: validLocations.map(({ location, path }) => ({
          ...location,
          path,
        })),
        limitations: [...new Set(validLocations.flatMap(({ file }) => file.limitations))],
        restoreStatus: validLocations.some(({ file }) => file.status === 'PARTIAL_RESTORED')
          ? 'PARTIAL_RESTORED'
          : 'RESTORED',
        lineMapping: first.file.lineMapping,
        lineMappings: validLocations
          .map(({ file }) => file.lineMapping)
          .filter((lineMapping): lineMapping is NonNullable<typeof lineMapping> => lineMapping !== undefined),
        ...(first.file.validation === undefined ? {} : { capabilityPreservation: first.file.validation.capability }),
      });
    }
  }

  return candidates;
}

async function collectDerivedFiles(restore: RestoreResult): Promise<DerivedFile[]> {
  const files: DerivedFile[] = [];
  const realOutputRoot = await realDerivedRoot(restore.outputRoot);
  if (realOutputRoot === undefined) return files;

  for (const restored of restore.restored) {
    const sourcePath = safePackageRelativePath(restored.path);
    if (sourcePath === undefined) continue;
    const expectedOutputPath = resolve(restore.outputRoot, sourcePath);
    const outputPath = await validateDerivedPath(
      realOutputRoot,
      expectedOutputPath,
      restored.outputPath,
    );
    if (outputPath === undefined) continue;

    const lineCount = await readLineCount(outputPath);
    if (lineCount !== undefined) {
      files.push({
        path: sourcePath,
        originalPath: sourcePath,
        outputPath,
        status: restored.status,
        lineCount,
        limitations: [...restored.limitations],
        lineMapping: restored.lineMapping,
        validation: restored.validation,
      });
    }

    for (const [index, payload] of restored.payloads.entries()) {
      const expectedPayloadPath = `${expectedOutputPath}.payload-${index + 1}.js`;
      const payloadOutputPath = await validateDerivedPath(
        realOutputRoot,
        expectedPayloadPath,
        payload.outputPath,
      );
      if (payloadOutputPath === undefined) continue;
      const payloadLineCount = await readLineCount(payloadOutputPath);
      if (payloadLineCount === undefined) continue;
      files.push({
        path: `${sourcePath}.payload-${index + 1}.js`,
        originalPath: sourcePath,
        outputPath: payloadOutputPath,
        status: restored.status,
        lineCount: payloadLineCount,
        limitations: [...restored.limitations],
        lineMapping: payload.lineMapping,
        validation: restored.validation,
      });
    }
  }

  return files;
}

async function readLineCount(path: string): Promise<number | undefined> {
  try {
    const source = await fs.readFile(path, 'utf8');
    if (source.length === 0) return 0;
    return source.split(/\r\n|\n|\r/u).length;
  } catch {
    return undefined;
  }
}

async function realDerivedRoot(outputRoot: string): Promise<string | undefined> {
  try {
    const rootStat = await fs.lstat(outputRoot);
    if (rootStat.isSymbolicLink()) return undefined;
    return await fs.realpath(outputRoot);
  } catch {
    return undefined;
  }
}

async function validateDerivedPath(
  realOutputRoot: string,
  expectedOutputPath: string,
  actualOutputPath: string,
): Promise<string | undefined> {
  try {
    const [realExpectedPath, realActualPath] = await Promise.all([
      fs.realpath(expectedOutputPath),
      fs.realpath(actualOutputPath),
    ]);
    if (
      !isWithinRoot(realOutputRoot, realExpectedPath)
      || !isWithinRoot(realOutputRoot, realActualPath)
      || !samePath(realExpectedPath, realActualPath)
    ) return undefined;
    return realActualPath;
  } catch {
    return undefined;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isDerivedAnalyzer(analyzer: string): analyzer is Tier2DerivedAnalyzer {
  return DERIVED_ANALYZERS.has(analyzer as Tier2DerivedAnalyzer);
}

function isRiskFinding(analyzer: Tier2DerivedAnalyzer, finding: Finding): boolean {
  if (
    finding.ruleId.startsWith('obfuscation.')
    || finding.type.startsWith('OBFUSCATION_')
  ) {
    return false;
  }

  const baseAnalyzer = analyzer.replace(/-deobfuscated$/u, '');
  const mapping = EVIDENCE_MAPPINGS.find(baseAnalyzer, finding.ruleId);
  return mapping?.targets.some(({ signalType }) => (
    BEHAVIOR_SIGNAL_TYPES.has(signalType)
  )) ?? false;
}

function getSourceLocations(finding: Finding): FindingLocation[] | undefined {
  const data = isRecord(finding.data) ? finding.data : undefined;
  const rawLocations = data?.locations;
  const locations = rawLocations === undefined
    ? finding.location === undefined ? [] : [finding.location]
    : Array.isArray(rawLocations)
      ? [
          ...(finding.location === undefined ? [] : [finding.location]),
          ...rawLocations,
        ]
      : undefined;
  if (locations === undefined || locations.some((location) => !isFindingLocation(location))) {
    return undefined;
  }
  const sourceLocations = locations.filter(
    (location): location is FindingLocation => location.type === 'SOURCE_FILE',
  );
  const seen = new Set<string>();
  return sourceLocations.filter((location) => {
    const key = JSON.stringify([
      location.path,
      location.startLine,
      location.startColumn,
      location.endLine,
      location.endColumn,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isFindingLocation(value: unknown): value is FindingLocation {
  if (!isRecord(value) || (value.type !== 'SOURCE_FILE' && value.type !== 'METADATA')) {
    return false;
  }
  return [value.startLine, value.startColumn, value.endLine, value.endColumn].every(
    (coordinate) => coordinate === undefined || typeof coordinate === 'number',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safePackageRelativePath(path: string | undefined): string | undefined {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) return undefined;
  const normalized = canonicalizeEvidencePath(path);
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//u.test(normalized)
    || normalized.split('/').includes('..')
  ) return undefined;
  return normalized;
}

function isWithinRoot(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  return (
    relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  );
}

function isValidLineRange(location: FindingLocation, lineCount: number): boolean {
  if (location.startLine === undefined) return false;
  const coordinates = [location.startLine, location.endLine];
  if (coordinates.some((line) => (
    line !== undefined && (!Number.isSafeInteger(line) || line <= 0 || line > lineCount)
  ))) return false;
  return (
    location.startLine === undefined
    || location.endLine === undefined
    || location.endLine >= location.startLine
  );
}
