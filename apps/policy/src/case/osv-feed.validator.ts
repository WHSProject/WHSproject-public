import { valid as validSemver, gte, lt, lte } from 'semver';
import type { EvaluationRequest, OsvFeed } from '../contracts/evidence';

export type OsvValidationStatus = 'VALID' | 'EMPTY' | 'PARTIAL' | 'ALL_EXCLUDED' | 'NOT_EVALUATED';

export interface OsvFeedEvidence {
  /** Policy-local reference; it is deliberately not added to request.evidences. */
  feedEvidenceId: string;
  advisorySource: string;
  advisoryId: string;
  aliases: string[];
  riskType: string;
  ecosystem: 'npm';
  packageName: string;
  packageVersion: string;
  rawSeverity: Array<{ path: string; value: unknown; basis: 'LABEL' | 'OSV_ORIGINAL' }>;
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  affected: Array<Record<string, unknown>>;
  fixedVersions: string[];
  references: Array<Record<string, unknown>>;
  collectedAt: string;
  validationStatus: 'APPLICABLE' | 'SEVERITY_CONFLICT' | 'UNSUPPORTED_RISK';
  validationCodes: string[];
}

export interface ValidatedOsvFeed {
  source: 'OSV';
  feedStatus: OsvFeed['feedStatus'];
  query: OsvFeed['query'];
  complete: boolean;
  pagesFetched: number;
  collectedAt: string | null;
  completedAt: string | null;
  validationStatus: OsvValidationStatus;
  errorCodes: string[];
  skippedReason: string | null;
  advisories: OsvFeedEvidence[];
  exclusions: Array<{ index: number; code: string }>;
}

const advisoryIdPattern = /^[A-Za-z][A-Za-z0-9_.:-]{1,255}$/u;
const severityMap: Record<string, OsvFeedEvidence['severity']> = {
  LOW: 'LOW', MODERATE: 'MEDIUM', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL',
};
const knownAdvisoryErrors = new Set([
  'INVALID_ADVISORY', 'INVALID_ADVISORY_ID', 'WITHDRAWN', 'INVALID_ALIASES',
  'INVALID_REFERENCES', 'INVALID_AFFECTED', 'ECOSYSTEM_MISMATCH', 'PACKAGE_MISMATCH',
  'INVALID_VERSION', 'INVALID_RANGE', 'UNSUPPORTED_RANGE', 'UNDETERMINED_VERSION',
  'VERSION_MISMATCH', 'INVALID_SEVERITY', 'INVALID_RISK_TYPE',
  'DUPLICATE_ADVISORY_ID',
]);
const feedStatuses = new Set(['SUCCESS', 'FAILED', 'TIMEOUT', 'SKIPPED']);
const errorCodes = new Set([
  'HTTP_ERROR', 'NETWORK_ERROR', 'INVALID_JSON', 'INVALID_RESPONSE',
  'RESPONSE_TOO_LARGE', 'TOTAL_RESPONSE_TOO_LARGE', 'JSON_TOO_DEEP',
  'JSON_STRING_TOO_LONG', 'PAGE_LIMIT_EXCEEDED', 'REPEATED_PAGE_TOKEN',
  'DEADLINE_EXCEEDED', 'SCAN_BUDGET_EXHAUSTED', 'PARENT_ABORTED',
]);
const timeoutCodes = new Set(['DEADLINE_EXCEEDED', 'SCAN_BUDGET_EXHAUSTED', 'PARENT_ABORTED']);
const skippedReasons = new Set([
  'DISABLED', 'UNSUPPORTED_TARGET', 'PRIVATE_PACKAGE', 'PROVENANCE_UNCONFIRMED',
  'INVALID_PACKAGE_IDENTITY', 'INVALID_SCAN_BUDGET',
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function version(value: unknown): string {
  if (typeof value !== 'string' || validSemver(value) !== value) throw new Error('INVALID_VERSION');
  return value;
}

function rangeContains(target: string, value: unknown): boolean {
  const range = record(value);
  if (!range || range.type !== 'SEMVER') throw new Error('UNSUPPORTED_RANGE');
  if (!Array.isArray(range.events) || range.events.length === 0) throw new Error('INVALID_RANGE');
  let introduced = false;
  let affected = false;
  for (const rawEvent of range.events) {
    const event = record(rawEvent);
    if (!event || Object.keys(event).length !== 1) throw new Error('INVALID_RANGE');
    const [kind, raw] = Object.entries(event)[0] ?? [];
    if (!kind || !['introduced', 'fixed', 'last_affected', 'limit'].includes(kind)) throw new Error('UNSUPPORTED_RANGE');
    if (typeof raw !== 'string') throw new Error('INVALID_RANGE');
    if (kind === 'introduced') {
      introduced = true;
      affected = raw === '0' || gte(target, version(raw));
    } else {
      if (!introduced) throw new Error('INVALID_RANGE');
      if (kind === 'fixed') affected = affected && lt(target, version(raw));
      else if (kind === 'last_affected') affected = affected && lte(target, version(raw));
      else affected = affected && (raw === '*' || lt(target, version(raw)));
    }
  }
  if (!introduced) throw new Error('INVALID_RANGE');
  return affected;
}

function matchingAffected(packageName: string, packageVersion: string, advisory: Record<string, unknown>): Array<{ index: number; item: Record<string, unknown> }> {
  if (!Array.isArray(advisory.affected) || advisory.affected.length === 0 || advisory.affected.some((item) => !record(item))) throw new Error('INVALID_AFFECTED');
  const items = advisory.affected.map((item, index) => ({ index, item: record(item)! }));
  if (items.some(({ item }) => !record(item.package))) throw new Error('INVALID_AFFECTED');
  const npmItems = items.filter(({ item }) => record(item.package)?.ecosystem === 'npm');
  if (npmItems.length === 0) throw new Error('ECOSYSTEM_MISMATCH');
  const packageItems = npmItems.filter(({ item }) => record(item.package)?.name === packageName);
  if (packageItems.length === 0) throw new Error('PACKAGE_MISMATCH');
  const target = version(packageVersion);
  const applicable = packageItems.filter(({ item }) => {
    const versions = item.versions ?? [];
    const ranges = item.ranges ?? [];
    if (!Array.isArray(versions) || !Array.isArray(ranges)) throw new Error('INVALID_RANGE');
    if (versions.length === 0 && ranges.length === 0) throw new Error('UNDETERMINED_VERSION');
    return versions.some((candidate) => version(candidate) === target) || ranges.some((candidate) => rangeContains(target, candidate));
  });
  if (applicable.length === 0) throw new Error('VERSION_MISMATCH');
  return applicable;
}

function rawSeverity(advisory: Record<string, unknown>, applicable: Array<{ index: number; item: Record<string, unknown> }>): { raw: OsvFeedEvidence['rawSeverity']; grades: NonNullable<OsvFeedEvidence['severity']>[] } {
  const raw: OsvFeedEvidence['rawSeverity'] = [];
  const grades: NonNullable<OsvFeedEvidence['severity']>[] = [];
  const add = (path: string, value: unknown, basis: 'LABEL' | 'OSV_ORIGINAL'): void => {
    raw.push({ path, value, basis });
    if (typeof value === 'string' && severityMap[value.toUpperCase()]) grades.push(severityMap[value.toUpperCase()]!);
  };
  const scoped = applicable.some(({ item }) => 'severity' in item || 'severity' in (record(item.database_specific) ?? {}));
  const sources = scoped ? applicable.map(({ index, item }) => ({ prefix: `affected[${index}].`, item })) : [{ prefix: '', item: advisory }];
  for (const { prefix, item } of sources) {
    const databaseSpecific = item.database_specific === undefined ? {} : record(item.database_specific);
    if (!databaseSpecific) throw new Error('INVALID_ADVISORY');
    if ('severity' in databaseSpecific) add(`${prefix}database_specific.severity`, databaseSpecific.severity, 'LABEL');
    const values = item.severity ?? [];
    if (!Array.isArray(values)) throw new Error('INVALID_SEVERITY');
    values.forEach((value, index) => add(`${prefix}severity[${index}]`, value, 'OSV_ORIGINAL'));
  }
  if (scoped) {
    add('severity', advisory.severity ?? [], 'OSV_ORIGINAL');
    add('database_specific.severity', record(advisory.database_specific)?.severity, 'OSV_ORIGINAL');
  }
  return { raw, grades };
}

function mapAdvisory(advisory: Record<string, unknown>, request: EvaluationRequest, collectedAt: string): OsvFeedEvidence {
  if (typeof advisory.id !== 'string' || !advisoryIdPattern.test(advisory.id)) throw new Error('INVALID_ADVISORY_ID');
  if (advisory.withdrawn !== undefined && advisory.withdrawn !== null) throw new Error('WITHDRAWN');
  const aliases = advisory.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== 'string' || !alias.trim())) throw new Error('INVALID_ALIASES');
  const references = advisory.references ?? [];
  if (!Array.isArray(references) || references.some((reference) => !record(reference) || typeof record(reference)?.url !== 'string' || !(record(reference)?.url as string).trim())) throw new Error('INVALID_REFERENCES');
  const applicable = matchingAffected(request.subject.packageName, request.subject.packageVersion, advisory);
  const { raw, grades } = rawSeverity(advisory, applicable);
  const databaseSpecific = advisory.database_specific === undefined ? {} : record(advisory.database_specific);
  if (!databaseSpecific) throw new Error('INVALID_ADVISORY');
  const riskType = databaseSpecific.risk_type ?? 'VULNERABILITY';
  if (typeof riskType !== 'string' || !riskType) throw new Error('INVALID_RISK_TYPE');
  const severityConflict = new Set(grades).size > 1;
  const validationCodes = [
    ...(severityConflict ? ['SEVERITY_CONFLICT'] : []),
    ...(grades.length === 0 ? [raw.length > 0 ? 'UNPARSED_SEVERITY' : 'MISSING_SEVERITY'] : []),
    ...(riskType !== 'VULNERABILITY' ? ['UNSUPPORTED_RISK'] : []),
  ];
  const fixedVersions: string[] = [];
  for (const { item } of applicable) {
    for (const range of Array.isArray(item.ranges) ? item.ranges : []) {
      const events = record(range)?.events;
      for (const event of Array.isArray(events) ? events : []) {
        const fixed = record(event)?.fixed;
        if (typeof fixed === 'string' && !fixedVersions.includes(fixed)) fixedVersions.push(fixed);
      }
    }
  }
  return {
    feedEvidenceId: `osv:${advisory.id}`,
    advisorySource: advisory.id.split('-', 1)[0]!, advisoryId: advisory.id,
    aliases: aliases as string[], riskType, ecosystem: 'npm',
    packageName: request.subject.packageName, packageVersion: request.subject.packageVersion,
    rawSeverity: raw, ...(grades.length > 0 && !severityConflict ? { severity: grades[0] } : {}),
    affected: applicable.map(({ item }) => item), fixedVersions,
    references: references as Array<Record<string, unknown>>, collectedAt,
    validationStatus: riskType !== 'VULNERABILITY' ? 'UNSUPPORTED_RISK' : severityConflict ? 'SEVERITY_CONFLICT' : 'APPLICABLE',
    validationCodes,
  };
}

export function validateOsvFeed(feed: OsvFeed, request: EvaluationRequest): ValidatedOsvFeed {
  if (!record(feed) || feed.source !== 'OSV') throw new Error('INVALID_OSV_SOURCE');
  if (!record(feed.query) || feed.query.ecosystem !== request.subject.ecosystem || feed.query.packageName !== request.subject.packageName || feed.query.packageVersion !== request.subject.packageVersion) throw new Error('OSV_QUERY_IDENTITY_MISMATCH');
  if (!feedStatuses.has(feed.feedStatus) || typeof feed.complete !== 'boolean' || !Array.isArray(feed.advisories) || !Number.isSafeInteger(feed.pagesFetched) || feed.pagesFetched < 0
    || (feed.collectedAt !== null && (typeof feed.collectedAt !== 'string' || Number.isNaN(Date.parse(feed.collectedAt))))
    || (feed.completedAt !== null && (typeof feed.completedAt !== 'string' || Number.isNaN(Date.parse(feed.completedAt))))
    || (feed.errorCode !== null && !errorCodes.has(feed.errorCode))
    || (feed.skippedReason !== null && !skippedReasons.has(feed.skippedReason))) throw new Error('INVALID_OSV_FEED');
  const base = { source: 'OSV' as const, feedStatus: feed.feedStatus, query: feed.query, complete: feed.complete, pagesFetched: feed.pagesFetched, collectedAt: feed.collectedAt, completedAt: feed.completedAt, skippedReason: feed.skippedReason };
  if (feed.feedStatus !== 'SUCCESS') {
    if (feed.complete || feed.advisories.length > 0 || feed.completedAt !== null) throw new Error('INVALID_OSV_FAILURE_STATE');
    if (feed.feedStatus === 'SKIPPED') {
      if (feed.pagesFetched !== 0 || feed.collectedAt !== null || feed.errorCode !== null || !feed.skippedReason) throw new Error('INVALID_OSV_SKIPPED_STATE');
    } else if (!feed.errorCode || feed.skippedReason !== null || (timeoutCodes.has(feed.errorCode) !== (feed.feedStatus === 'TIMEOUT'))) throw new Error('INVALID_OSV_ERROR_STATE');
    return { ...base, validationStatus: 'NOT_EVALUATED', errorCodes: feed.errorCode ? [feed.errorCode] : [], advisories: [], exclusions: [] };
  }
  if (!feed.complete || feed.collectedAt === null || feed.completedAt === null || feed.errorCode !== null || feed.skippedReason !== null) throw new Error('INVALID_OSV_SUCCESS_STATE');
  const advisories: OsvFeedEvidence[] = [];
  const exclusions: Array<{ index: number; code: string }> = [];
  const advisoryIds = new Set<string>();
  feed.advisories.forEach((raw, index) => {
    try {
      const advisory = mapAdvisory(raw, request, feed.collectedAt!);
      if (advisoryIds.has(advisory.advisoryId)) throw new Error('DUPLICATE_ADVISORY_ID');
      advisoryIds.add(advisory.advisoryId);
      advisories.push(advisory);
    }
    catch (error) { exclusions.push({ index, code: error instanceof Error && knownAdvisoryErrors.has(error.message) ? error.message : 'INVALID_ADVISORY' }); }
  });
  const validationStatus: OsvValidationStatus = advisories.length > 0 && exclusions.length > 0 ? 'PARTIAL'
    : advisories.length > 0 ? 'VALID' : exclusions.length > 0 ? 'ALL_EXCLUDED' : 'EMPTY';
  return { ...base, validationStatus, errorCodes: [], advisories, exclusions };
}
