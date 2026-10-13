import { createServer } from 'node:http';
import { FixturePolicyLlmProvider, OpenAiPolicyLlmProvider } from './llm/policy-llm.provider';
import { PolicyEvaluationService } from './evaluation/policy-evaluation.service';
import { parseEvaluationRequest } from './contracts/parse-evaluation-request';
import { HttpActivePolicyClient, PolicyDbError } from './policy/active-policy.client';
import { DecisionDbError, HttpDecisionDbClient } from './decision/decision-db.client';
import { buildPolicyEvaluationResponse } from './evaluation/policy-evaluation.response';
import { buildFeedPersistencePayload, FeedPersistenceError, HttpFeedPersistenceClient } from './feed/feed-persistence.client';
import { validateOsvFeed } from './case/osv-feed.validator';
import { HttpPolicyLlmAuditClient, PolicyLlmAuditDbError } from './llm/policy-llm-audit.client';
import { createDefaultReevaluationProcessor } from './reevaluation/reevaluation.processor';
import { feedContentDigest } from './feed/feed-persistence.client';
import type { EvaluationRequest } from './contracts/evidence';

const port = Number(process.env.POLICY_PORT ?? 8000);
const provider = process.env.POLICY_LLM_MODE === 'fixture'
  ? new FixturePolicyLlmProvider()
  : new OpenAiPolicyLlmProvider({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.POLICY_LLM_MODEL ?? 'gpt-4.1-mini',
    baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
  });
const shadowProvider = process.env.POLICY_LLM_SHADOW_MODE === 'fixture'
  ? new FixturePolicyLlmProvider()
  : process.env.POLICY_LLM_SHADOW_MODE === 'openai'
    ? new OpenAiPolicyLlmProvider({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.POLICY_LLM_SHADOW_MODEL ?? process.env.POLICY_LLM_MODEL ?? 'gpt-4.1-mini',
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com',
    })
    : undefined;
const evaluationService = new PolicyEvaluationService(provider, Number(process.env.POLICY_LLM_TIMEOUT_MS ?? 20_000), shadowProvider);
const activePolicyClient = new HttpActivePolicyClient();
const decisionDbClient = new HttpDecisionDbClient();
const llmAuditClient = new HttpPolicyLlmAuditClient();
const feedPersistenceClient = new HttpFeedPersistenceClient();
const reevaluationProcessor = createDefaultReevaluationProcessor(evaluationService);

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', service: 'policy-ts' }));
    return;
  }
  const reevaluationMatch = request.method === 'POST'
    ? /^\/internal\/v1\/reevaluation-jobs\/([^/]+)\/process$/u.exec(request.url ?? '')
    : null;
  if (reevaluationMatch?.[1]) {
    const result = await reevaluationProcessor.process(reevaluationMatch[1]);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
    return;
  }
  if (request.method === 'POST' && request.url === '/internal/v1/feed-validation') {
    try {
      const payload = JSON.parse(await readBody(request)) as { feed?: unknown };
      if (!payload.feed || typeof payload.feed !== 'object' || Array.isArray(payload.feed)) throw new Error('INVALID_FEED_VALIDATION_REQUEST');
      const feed = payload.feed as EvaluationRequest['osvFeed'];
      const query = feed.query;
      if (!query || typeof query !== 'object') throw new Error('INVALID_FEED_VALIDATION_REQUEST');
      const evaluationRequest = {
        requestId: 'feed-refresh-validation', scanId: 'feed-refresh-validation', scanStatus: 'COMPLETED' as const,
        subject: { ecosystem: 'npm' as const, packageName: query.packageName, packageVersion: query.packageVersion, artifactHash: 'sha256:feed-refresh', integrity: 'sha512-feed-refresh' },
        evidences: [], osvFeed: feed,
      } as EvaluationRequest;
      const validated = validateOsvFeed(feed, evaluationRequest);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        contentDigest: feedContentDigest(evaluationRequest, validated),
        validationResult: {
          validationStatus: validated.validationStatus, advisories: validated.advisories,
          exclusions: validated.exclusions, errorCodes: validated.errorCodes,
          pagesFetched: validated.pagesFetched, completedAt: validated.completedAt,
        },
      }));
    } catch (error) {
      response.writeHead(422, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'INVALID_FEED_VALIDATION_REQUEST', message: error instanceof Error ? error.message : 'Invalid feed' }));
    }
    return;
  }
  if (request.method !== 'POST' || request.url !== '/internal/v1/evaluations') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'NOT_FOUND' }));
    return;
  }
  try {
    const payload = JSON.parse(await readBody(request));
    const evaluationRequest = parseEvaluationRequest(payload);
    const feedValidatedAt = new Date().toISOString();
    const validatedFeed = validateOsvFeed(evaluationRequest.osvFeed, evaluationRequest);
    const feedPersistence = await feedPersistenceClient.save(buildFeedPersistencePayload(evaluationRequest, validatedFeed, feedValidatedAt));
    const policy = await activePolicyClient.fetchActive();
    const evaluation = await evaluationService.evaluate(evaluationRequest, policy);
    const evaluatedAt = new Date().toISOString();
    if (evaluation.audit) await llmAuditClient.save(evaluation.audit);
    if (evaluation.shadow) await llmAuditClient.save(evaluation.shadow.audit);
    const persistence = await decisionDbClient.save(evaluationRequest, policy, evaluation.decision, evaluatedAt, {
      snapshotId: feedPersistence.snapshotId,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(buildPolicyEvaluationResponse(evaluation, persistence, evaluatedAt)));
  } catch (error) {
    const status = error instanceof SyntaxError || error instanceof Error && /^(INVALID_|DUPLICATE_|MULTIPLE_|SCAN_ID_|UNKNOWN_|OSV_)/u.test(error.message)
      ? 422
      : error instanceof PolicyDbError && (error.message === 'POLICY_DB_INVALID_RESPONSE' || error.message.startsWith('POLICY_DB_INVALID_') || error.message.startsWith('POLICY_DB_SCORE_') || error.message.startsWith('POLICY_DB_LEGACY_')) ? 502
      : error instanceof DecisionDbError && error.message === 'DECISION_DB_INVALID_RESPONSE' ? 502
        : error instanceof PolicyLlmAuditDbError && error.message === 'POLICY_LLM_AUDIT_DB_INVALID_RESPONSE' ? 502
        : error instanceof FeedPersistenceError && error.message === 'FEED_PERSISTENCE_INVALID_RESPONSE' ? 502
          : error instanceof PolicyDbError || error instanceof DecisionDbError || error instanceof PolicyLlmAuditDbError || error instanceof FeedPersistenceError ? 503 : 500;
    const code = error instanceof PolicyDbError && (error.message === 'POLICY_DB_INVALID_RESPONSE' || error.message.startsWith('POLICY_DB_INVALID_') || error.message.startsWith('POLICY_DB_SCORE_') || error.message.startsWith('POLICY_DB_LEGACY_'))
      ? 'POLICY_DB_INVALID_RESPONSE'
      : error instanceof PolicyDbError ? 'POLICY_DB_UNAVAILABLE'
          : error instanceof DecisionDbError && error.message === 'DECISION_DB_INVALID_RESPONSE' ? 'DECISION_DB_INVALID_RESPONSE'
            : error instanceof DecisionDbError ? 'DECISION_DB_UNAVAILABLE'
            : error instanceof PolicyLlmAuditDbError && error.message === 'POLICY_LLM_AUDIT_DB_INVALID_RESPONSE' ? 'POLICY_LLM_AUDIT_DB_INVALID_RESPONSE'
            : error instanceof PolicyLlmAuditDbError ? 'POLICY_LLM_AUDIT_DB_UNAVAILABLE'
            : error instanceof FeedPersistenceError ? error.message
          : status === 422 ? 'INVALID_EVALUATION_REQUEST' : 'POLICY_EVALUATION_FAILED';
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code, message: error instanceof Error ? error.message : 'Unknown policy failure', retryable: status >= 500 }));
  }
});

server.listen(port, () => console.log(`policy-ts listening on ${port}`));

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) { reject(new Error('REQUEST_TOO_LARGE')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
