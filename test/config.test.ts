import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprint, parseConfig } from '../src/config.ts';

const target = { provider: 'operator-provider', model: 'exact/model-id', effort: 'off' };
test('operator configuration is finite, exact, secret-free and versioned', () => {
  const parsed = parseConfig({ version: 1, chains: { work: [target] } });
  assert.deepEqual(parsed.chains.work, [target]);
  assert.equal(fingerprint(parsed.chains.work), fingerprint(parseConfig({ chains: { work: [{ effort: 'off', model: 'exact/model-id', provider: 'operator-provider' }] }, version: 1 }).chains.work));
  for (const invalid of [
    null, {}, { version: 2, chains: { work: [target] } }, { version: 1, chains: {} },
    { version: 1, chains: { work: [] } }, { version: 1, chains: { '../work': [target] } },
    { version: 1, chains: { work: [{ ...target, effort: 'auto' }] } },
    { version: 1, chains: { work: [{ ...target, model: '*' }] } },
    { version: 1, chains: { work: [{ ...target, provider: '' }] } },
    { version: 1, chains: { work: [{ ...target, apiKey: 'forbidden' }] } },
    { version: 1, chains: { work: [target, { effort: 'off', model: target.model, provider: target.provider }] } },
    { version: 1, chains: { work: [target] }, enabled: true },
  ]) assert.throws(() => parseConfig(invalid));
});
