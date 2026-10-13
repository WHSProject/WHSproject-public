import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CUSTOM_RULE_TIMEOUT_MS, DEFAULT_POLICY_TIMEOUT_MS, DEFAULT_SCANNER_PACKAGE_TIMEOUT_MS, loadLlmAgentEnvironment } from '../src/config/scanner-environment';

const root = resolve(__dirname, '../../..');
const compose = readFileSync(resolve(root, 'compose.yaml'), 'utf8').replace(/\r\n/gu, '\n');
const dockerfile = readFileSync(resolve(root, 'apps/scanner/Dockerfile'), 'utf8').replace(/\r\n/gu, '\n');
const example = readFileSync(resolve(root, '.env.example'), 'utf8').replace(/\r\n/gu, '\n');
const policyMain = readFileSync(resolve(root, 'apps/policy/src/main.ts'), 'utf8');
const gatewayConfig = readFileSync(resolve(root, 'apps/gateway/src/config/scanner.config.ts'), 'utf8');

it('pins the Scanner service to NestJS runtime while retaining the external GuardDog target', () => {
  const scanner = compose.match(/^  scanner:\n([\s\S]*?)(?=^  [a-z][\w-]*:|^volumes:)/m)?.[1];
  const evidenceApi = compose.match(/^  evidence-api:\n([\s\S]*?)(?=^  [a-z][\w-]*:|^volumes:)/m)?.[1];
  expect(scanner).toBeDefined();
  expect(scanner).toMatch(/^    build:\n      context: \.\n      dockerfile: apps\/scanner\/Dockerfile\n      target: runtime$/m);
  expect(scanner).not.toMatch(/^    entrypoint:/m);
  expect(scanner).toMatch(/^    networks:\n      - whs$/m);
  expect(evidenceApi).toMatch(/^    networks:\n      - default\n      - whs$/m);
  expect(dockerfile).toMatch(/^FROM node:24-bookworm-slim AS runtime$/m);
  expect(dockerfile).toMatch(/^CMD \["pnpm", "--filter", "scanner", "start"\]$/m);
  expect(dockerfile).toMatch(/^FROM runtime AS external-guarddog\n\nUSER 65532:65532\nENTRYPOINT \["guarddog"\]$/m);
});

it('keeps the finite default timeout budget aligned across code, Compose and env example', () => {
  const scanner = compose.match(/^  scanner:\n([\s\S]*?)(?=^  [a-z][\w-]*:|^volumes:)/m)?.[1];
  const policyLlm = Number((policyMain.match(/POLICY_LLM_TIMEOUT_MS \?\? ([\d_]+)/)?.[1] ?? '').replaceAll('_', ''));
  const gateway = Number((gatewayConfig.match(/DEFAULT_SCANNER_TIMEOUT_MS = ([\d_]+)/)?.[1] ?? '').replaceAll('_', ''));
  expect(Number.isSafeInteger(policyLlm)).toBe(true);
  expect(Number.isSafeInteger(gateway)).toBe(true);
  expect(DEFAULT_POLICY_TIMEOUT_MS).toBeGreaterThan(policyLlm);
  expect(DEFAULT_SCANNER_PACKAGE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_POLICY_TIMEOUT_MS);
  expect(DEFAULT_SCANNER_PACKAGE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_CUSTOM_RULE_TIMEOUT_MS + DEFAULT_POLICY_TIMEOUT_MS);
  expect(gateway).toBeGreaterThan(DEFAULT_SCANNER_PACKAGE_TIMEOUT_MS);
  expect(scanner).toContain(`POLICY_TIMEOUT_MS: \${POLICY_TIMEOUT_MS:-${DEFAULT_POLICY_TIMEOUT_MS}}`);
  expect(scanner).toContain(`SCANNER_PACKAGE_TIMEOUT_MS: \${SCANNER_PACKAGE_TIMEOUT_MS:-${DEFAULT_SCANNER_PACKAGE_TIMEOUT_MS}}`);
  expect(example).toMatch(new RegExp(`^POLICY_TIMEOUT_MS=${DEFAULT_POLICY_TIMEOUT_MS}$`, 'm'));
  expect(example).toMatch(new RegExp(`^SCANNER_PACKAGE_TIMEOUT_MS=${DEFAULT_SCANNER_PACKAGE_TIMEOUT_MS}$`, 'm'));
  expect(compose).toContain('POLICY_LLM_TIMEOUT_MS: ${POLICY_LLM_TIMEOUT_MS:-20000}');
  expect(compose).toContain('SCANNER_TIMEOUT_MS: ${SCANNER_TIMEOUT_MS:-300000}');
});

const tier3Variables = [
  'OPENAI_BASE_URL', 'LLM_AGENT_PROVIDER', 'LLM_AGENT_ENABLED', 'LLM_AGENT_TRIGGER_MODE',
  'LLM_AGENT_MODEL', 'LLM_AGENT_TIMEOUT_MS', 'LLM_AGENT_MAX_RETRIES',
] as const;

it.each(['\n', '\r\n'])('passes Tier3 settings to the Scanner with runtime defaults for %j line endings', (lineEnding) => {
  const source = compose.replace(/\n/gu, lineEnding).replace(/\r\n/gu, '\n');
  const scanner = source.match(/^  scanner:\n([\s\S]*?)(?=^  [a-z][\w-]*:|^volumes:)/m)?.[1];
  expect(scanner).toBeDefined();
  const environment = scanner?.match(/^    environment:\n([\s\S]*?)(?=^    \S)/m)?.[1];
  expect(environment).toBeDefined();
  const defaults = loadLlmAgentEnvironment({});
  for (const variable of tier3Variables) {
    const entries = environment!.split('\n').filter((line) => line.trimStart().startsWith(`${variable}:`));
    expect(entries).toEqual([`      ${variable}: \${${variable}:-${defaults[variable]}}`]);
  }
  expect(environment).toContain('      OPENAI_API_KEY: ${OPENAI_API_KEY:-}');
});

it('keeps Tier3 env examples unique and valid for the current runtime config', () => {
  const variables = [...tier3Variables, 'OPENAI_API_KEY'];
  const settings: Record<string, string> = {};
  for (const variable of variables) {
    const entries = example.split('\n').filter((line) => line.startsWith(`${variable}=`));
    expect(entries).toHaveLength(1);
    settings[variable] = entries[0]!.slice(variable.length + 1);
  }
  const defaults = loadLlmAgentEnvironment({});
  expect(loadLlmAgentEnvironment(settings)).toMatchObject({
    OPENAI_BASE_URL: defaults.OPENAI_BASE_URL,
    LLM_AGENT_PROVIDER: defaults.LLM_AGENT_PROVIDER,
    LLM_AGENT_ENABLED: false,
    LLM_AGENT_TIMEOUT_MS: defaults.LLM_AGENT_TIMEOUT_MS,
    LLM_AGENT_MAX_RETRIES: defaults.LLM_AGENT_MAX_RETRIES,
  });
  expect(settings.OPENAI_API_KEY).toBe('');
});
