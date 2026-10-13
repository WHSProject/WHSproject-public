import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpActivePolicyClient, parseActivePolicy, PolicyDbError } from './active-policy.client';

test('active policy client maps DB rules into the typed policy snapshot', async () => {
  const client = new HttpActivePolicyClient('http://policy-db', 100, async () => new Response(JSON.stringify({
    policyKey: 'npm-policy', policyVersion: '2.1.0', ecosystem: 'npm', rules: [{
      ruleId: 'R-1', decision: 'REJECT', priority: 100, reasonCode: 'BLOCK', reason: 'block',
      conditions: { when: { allOf: [{ predicate: 'DATA_REACHES_EXTERNAL_SINK' }] }, minimumSupport: 'SUPPORTED', onUnknown: 'HOLD' },
    }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const snapshot = await client.fetchActive();
  assert.equal(snapshot.policyVersion, '2.1.0');
  assert.equal(snapshot.defaultDecision, 'ACCEPT');
  assert.equal(snapshot.rules[0]?.when.allOf?.[0]?.predicate, 'DATA_REACHES_EXTERNAL_SINK');
  assert.equal(snapshot.predicateCatalog?.[0]?.code, 'DATA_REACHES_EXTERNAL_SINK');
  assert.equal(snapshot.policyHash?.length, 64);
});

test('active policy runtime uses ACCEPT when no rule matches, even if the DB response says REVIEW', () => {
  const snapshot = parseActivePolicy({
    policyKey: 'qa-npm-policy', policyVersion: '0.1.0', ecosystem: 'npm', defaultDecision: 'REVIEW', rules: [],
  });
  assert.equal(snapshot.defaultDecision, 'ACCEPT');
});

test('active policy client accepts a predicate registered by Policy DB', () => {
  const snapshot = parseActivePolicy({
    policyKey: 'p', policyVersion: '1', ecosystem: 'npm',
    predicates: [{ code: 'CUSTOM_BEHAVIOR_MATCH', description: 'A tenant-defined behavior.', category: 'custom', rejectAllowed: false }],
    rules: [{ ruleId: 'custom-rule', decision: 'REVIEW', priority: 10, reasonCode: 'CUSTOM', reason: 'custom', conditions: { when: { allOf: [{ predicate: 'CUSTOM_BEHAVIOR_MATCH' }] } } }],
  });
  assert.equal(snapshot.rules[0]?.when.allOf?.[0]?.predicate, 'CUSTOM_BEHAVIOR_MATCH');
  assert.equal(snapshot.predicateCatalog?.[0]?.rejectAllowed, false);
});

test('active policy client rejects a rule that is absent from the predicate registry', () => {
  assert.throws(() => parseActivePolicy({
    policyKey: 'p', policyVersion: '1', ecosystem: 'npm',
    predicates: [{ code: 'REGISTERED_BEHAVIOR', description: 'registered' }],
    rules: [{ ruleId: 'unknown-rule', decision: 'REVIEW', reasonCode: 'UNKNOWN', reason: 'unknown', conditions: { when: { allOf: [{ predicate: 'NOT_REGISTERED' }] } } }],
  }), /POLICY_DB_UNKNOWN_PREDICATE:NOT_REGISTERED/u);
});

test('active policy client rejects legacy score conditions', () => {
  assert.throws(() => parseActivePolicy({ policyKey: 'p', policyVersion: '1', ecosystem: 'npm', rules: [{ ruleId: 'old', decision: 'ACCEPT', reasonCode: 'OLD', reason: 'old', conditions: { scoreGte: 80 } }] }), (error: unknown) => error instanceof PolicyDbError && error.message.startsWith('POLICY_DB_LEGACY_RULE_UNSUPPORTED'));
});
