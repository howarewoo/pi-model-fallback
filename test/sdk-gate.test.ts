import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoveryProbe } from './recovery-probe.ts';
import { Type } from 'typebox';
import { installFallback } from '../src/fallback.ts';
import { parseConfig } from '../src/config.ts';

const config = (models = ['a', 'b']) => parseConfig({ version: 1, chains: { probe: models.map(model => ({ provider: 'fixture', model, effort: 'off' })) } });
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext, type ProviderConfig } from '@earendil-works/pi-coding-agent';

async function fixture(error: string | ((attempt: number) => string), observe: (pi: ExtensionAPI) => void, script?: (attempt: number) => 'tool' | 'partial' | 'success' | 'error' | 'length') {
  const dir = await mkdtemp(join(tmpdir(), 'fallback-sdk-'));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, provider: { maxRetries: 0 } } });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const calls: string[] = [];
  const projections: unknown[] = [];
  const dispatches: Array<{ provider: string; model: string; effort: string | undefined }> = [];
  const provider: ProviderConfig = {
    api: 'openai-completions', apiKey: 'fixture-not-a-secret', baseUrl: 'https://invalid.example',
    models: ['a', 'b'].map(id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model, context, options) {
      calls.push(model.id);
      dispatches.push({ provider: model.provider, model: model.id, effort: options?.reasoning });
      projections.push(structuredClone(context.messages));
      const stream = createAssistantMessageEventStream();
      const step = script?.(calls.length);
      const failed = step ? step === 'error' || step === 'partial' : model.id === 'a';
      const message: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: [{ type: 'text', text: failed ? 'abandoned draft' : 'recovered' }],
        stopReason: failed ? 'error' : 'stop', ...(failed ? { errorMessage: typeof error === 'string' ? error : error(calls.length) } : {}),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      if (step === 'tool' || step === 'partial') {
        message.content.push({ type: 'toolCall', id: `call-${calls.length}`, name: 'counter', arguments: {} });
        if (step === 'tool') message.stopReason = 'toolUse';
      }
      if (step === 'length') {
        message.stopReason = 'length';
        message.usage.output = 1;
        message.usage.totalTokens = 1;
      }
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'text_start', contentIndex: 0, partial: message });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: failed ? 'abandoned draft' : 'recovered', partial: message });
      stream.push({ type: 'text_end', contentIndex: 0, content: message.content[0].type === 'text' ? message.content[0].text : '', partial: message });
      if (step === 'tool' || step === 'partial') {
        stream.push({ type: 'toolcall_start', contentIndex: 1, partial: message });
        stream.push({ type: 'toolcall_delta', contentIndex: 1, delta: step === 'partial' ? '{' : '{}', partial: message });
        if (step === 'tool') stream.push({ type: 'toolcall_end', contentIndex: 1, toolCall: { type: 'toolCall', id: `call-${calls.length}`, name: 'counter', arguments: {} }, partial: message });
      }
      if (failed) stream.push({ type: 'error', reason: 'error', error: message });
      else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : message.stopReason === 'length' ? 'length' : 'stop', message });
      stream.end();
      return stream;
    },
  };
  runtime.registerProvider('fixture', provider);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [observe] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime,
    model: runtime.getModel('fixture', 'a')!, resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.create(dir, join(dir, 'sessions')), tools: ['counter'] });
  return { session, calls, dispatches, provider, projections, settings, runtime, dir, async close() { session.dispose(); await rm(dir, { recursive: true, force: true }); } };
}

test('public boundary can omit quota failure and continue without a fake user message', async () => {
  let boundaries = 0;
  let signal: AbortSignal | undefined;
  const f = await fixture('insufficient_quota', pi => {
    pi.on('agent_before_settle', async (event, ctx) => {
      boundaries++;
      signal = ctx.signal;
      if (boundaries > 1) return;
      const failed = ctx.sessionManager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'assistant');
      assert.ok(failed);
      await pi.setModel(ctx.modelRegistry.find('fixture', 'b')!);
      return { entries: [...event.entries, { type: 'context_edit', targetId: failed.id, replacement: null }], continue: true };
    });
  });
  try {
    await f.session.prompt('recover this request');
    assert.deepEqual(f.calls, ['a', 'b']);
    assert.equal(f.session.state.messages.filter(m => m.role === 'user').length, 1);
    // The boundary has no live signal; recovery backoff must run in the next router call.
    assert.equal(signal, undefined);
  } finally { await f.close(); }
});

for (const error of ['insufficient_quota', '503 service unavailable']) {
  test(`virtual boundary recovery dispatches A/A/A/B: ${error}`, async () => {
    const f = await fixture(error, pi => recoveryProbe(pi));
    try {
      await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
      await f.session.prompt('recover');
      assert.deepEqual(f.calls, ['a', 'a', 'a', 'b']);
      await f.session.prompt('next request');
      assert.deepEqual(f.calls, ['a', 'a', 'a', 'b', 'b']);
      assert.equal(f.session.sessionManager.getBranch().filter(e => e.type === 'message' && e.message.role === 'assistant' && e.message.stopReason === 'error').length, 3);
    } finally { await f.close(); }
  });
}

test('backoff runs in fresh router signal and abort prevents another physical dispatch', async () => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture('insufficient_quota', pi => recoveryProbe(pi, 60_000, entered));
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    const running = f.session.prompt('recover');
    await waiting;
    await f.session.abort();
    await running;
    assert.deepEqual(f.calls, ['a']);
  } finally { await f.close(); }
});

test('public effective settings observe retry toggle and provider retry configuration', async () => {
  let context: ExtensionContext | undefined;
  let api: ExtensionAPI | undefined;
  const f = await fixture('insufficient_quota', pi => {
    api = pi;
    pi.on('agent_before_settle', (_e, ctx) => { context = ctx; });
  });
  try {
    await f.session.prompt('check settings');
    assert.equal(api!.getSettings().retry?.maxRetries, 2);
    assert.equal(api!.getSettings().retry?.provider?.maxRetries, 0);
    f.session.setAutoRetryEnabled(false);
    assert.equal(api!.getSettings().retry?.enabled, false);
    assert.ok(context);
  } finally { await f.close(); }
});

test('interrupted draft does not execute partial calls or replay a completed tool', async () => {
  let executions = 0;
  const f = await fixture('connection reset', pi => {
    installFallback(pi, config());
    pi.registerTool({ name: 'counter', label: 'Counter', description: 'Count', parameters: Type.Object({}),
      async execute() { executions++; return { content: [{ type: 'text', text: 'completed once' }], details: {} }; } });
  }, attempt => attempt === 1 ? 'tool' : attempt <= 4 ? 'partial' : 'success');
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('perform one action');
    assert.deepEqual(f.calls, ['a', 'a', 'a', 'a', 'b']);
    assert.equal(executions, 1);
    const projection = f.projections.at(-1) as Array<{ role: string; stopReason?: string; toolCallId?: string }>;
    assert.equal(projection.filter(m => m.role === 'toolResult').length, 1);
    assert.equal(projection.filter(m => m.stopReason === 'error').length, 0);
    assert.equal(projection.filter(m => m.stopReason === 'toolUse').length, 1);
  } finally { await f.close(); }
});

test('branch/reset routing survives reload; direct calls are read-only', async () => {
  let context: ExtensionContext | undefined;
  const f = await fixture('insufficient_quota', pi => {
    installFallback(pi, config());
    pi.on('agent_before_settle', (_e, ctx) => { context = ctx; });
    pi.on('session_before_compact', event => ({ compaction: { summary: 'Deterministic summary', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
  });
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('recover');
    const backupLeaf = f.session.sessionManager.getLeafId()!;
    await f.session.reload();
    await f.session.prompt('after reload');
    assert.equal(f.calls.at(-1), 'b');
    const reopened = SessionManager.open(f.session.sessionManager.getSessionFile()!);
    assert.deepEqual(reopened.getBranch(), f.session.sessionManager.getBranch());
    const before = f.session.sessionManager.getBranch().length;
    const direct = await context!.modelRegistry.streamSimple(f.runtime.getModel('fallback', 'probe')!, { messages: [{ role: 'user', content: 'direct', timestamp: Date.now() }] }).result();
    assert.equal(direct.stopReason, 'stop');
    assert.equal(f.calls.length, 6);
    assert.equal(f.calls.at(-1), 'b');
    assert.equal(f.session.sessionManager.getBranch().length, before);
    const count = f.calls.length;
    await f.session.prompt('/fallback-reset');
    assert.equal(f.calls.length, count);
    await f.session.prompt('reset branch');
    assert.deepEqual(f.calls.slice(count), ['a', 'a', 'a', 'b']);
    await f.session.navigateTree(backupLeaf, { summarize: false });
    await f.session.prompt('original backup branch');
    assert.equal(f.calls.at(-1), 'b');
    assert.equal(f.calls.length, count + 5);
    f.settings.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 1024 } });
    await f.session.compact();
    await f.session.prompt('after compaction');
    assert.equal(f.calls.at(-1), 'b');
    assert.equal(f.calls.length, count + 6);
  } finally { await f.close(); }
});

for (const error of [
  'insufficient_quota', '503 service unavailable',
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your usage limit."}}',
]) {
  test(`standalone controller implements bounded sticky recovery: ${error}`, async () => {
    const f = await fixture(error, pi => installFallback(pi, config(['a', 'missing', 'b'])));
    try {
      await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
      await f.session.prompt('recover');
      assert.deepEqual(f.calls, ['a', 'a', 'a', 'b']);
      await f.session.prompt('stay on backup');
      assert.equal(f.calls.at(-1), 'b');
      const count = f.calls.length;
      await f.session.prompt('/fallback-reset');
      assert.equal(f.calls.length, count);
      await f.session.prompt('primary again');
      assert.deepEqual(f.calls.slice(count), ['a', 'a', 'a', 'b']);
    } finally { await f.close(); }
  });
}

for (const error of [
  '401 unauthorized', '403 permission denied', 'invalid request', 'content policy refusal',
  '400 {"error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}',
  '400 invalid_request_error: server overloaded',
  '401 authentication failed: credit balance unavailable',
  '403 permission denied: usage limit exceeded',
  'request cancelled: insufficient_quota',
  'content policy refusal: credit balance unavailable',
]) {
  test(`terminal failure never recovers: ${error}`, async () => {
    const f = await fixture(error, pi => installFallback(pi, config()));
    try {
      await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
      await f.session.prompt('no recovery');
      assert.deepEqual(f.calls, ['a']);
    } finally { await f.close(); }
  });
}

test('chain exhaustion is latched; reset sends no call', async () => {
  const f = await fixture('insufficient_quota', pi => installFallback(pi, config(['a'])));
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('exhaust');
    assert.deepEqual(f.calls, ['a', 'a', 'a']);
    await f.session.prompt('must not wrap');
    assert.equal(f.calls.length, 3);
    await f.session.prompt('/fallback-reset');
    assert.equal(f.calls.length, 3);
    await f.session.prompt('try again');
    assert.equal(f.calls.length, 6);
  } finally { await f.close(); }
});

for (const priorFailure of [false, true]) {
  test(`native truncated-response compaction retries the same target without spending its budget (prior failure: ${priorFailure})`, async () => {
    const lengthAttempt = priorFailure ? 3 : 2;
    const f = await fixture('503 service unavailable', pi => {
      installFallback(pi, config());
      pi.on('session_before_compact', event => ({ compaction: { summary: 'Deterministic summary', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
    }, attempt => attempt === 1 ? 'success' : attempt === lengthAttempt ? 'length' : attempt <= 5 ? 'error' : 'success');
    try {
      f.settings.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1024 } });
      await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
      await f.session.prompt('warmup');
      await f.session.prompt('recover a truncated response');
      assert.deepEqual(f.calls, ['a', 'a', 'a', 'a', 'a', 'b']);
      const branch = f.session.sessionManager.getBranch();
      assert.equal(branch.filter(e => e.type === 'compaction').length, 1);
      const lengthIndex = branch.findIndex(e => e.type === 'message' && e.message.role === 'assistant' && e.message.stopReason === 'length');
      const state = branch.slice(lengthIndex + 1).find(e => e.type === 'custom' && e.customType === 'model-fallback.state.v1');
      assert.ok(state?.type === 'custom');
      assert.equal((state.data as { failures: number }).failures, priorFailure ? 1 : 0);
      assert.ok(!JSON.stringify(f.session.state.messages).includes('not eligible for recovery'));
    } finally { await f.close(); }
  });
}

test('success clears consecutive failures without selecting another model', async () => {
  const f = await fixture('insufficient_quota', pi => installFallback(pi, config()), attempt => attempt === 3 || attempt === 6 ? 'success' : 'error');
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('recover on retry two');
    assert.deepEqual(f.calls, ['a', 'a', 'a']);
    await f.session.prompt('fresh retry budget');
    assert.deepEqual(f.calls, ['a', 'a', 'a', 'a', 'a', 'a']);
  } finally { await f.close(); }
});

test('mixed quota/transient episode retains a total of two same-model retries', async () => {
  const f = await fixture(attempt => attempt === 1 ? 'insufficient_quota' : '503 service unavailable', pi => installFallback(pi, config()));
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('recover mixed failures');
    assert.deepEqual(f.calls, ['a', 'a', 'a', 'b']);
  } finally { await f.close(); }
});

for (const errors of [
  ['quota', 'transient', 'transient', 'transient', 'transient', 'transient'],
  ['transient', 'quota', 'transient', 'transient', 'quota', 'transient'],
  ['transient', 'transient', 'quota', 'quota', 'transient', 'quota'],
  ['quota', 'quota', 'transient', 'transient', 'transient', 'quota'],
]) {
  test(`backup gets its own exact budget through exhaustion: ${errors.join('/')}`, async () => {
    const f = await fixture(attempt => errors[attempt - 1] === 'quota' ? 'insufficient_quota' : '503 service unavailable', pi => installFallback(pi, config()), () => 'error');
    try {
      await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
      await f.session.prompt('exhaust every target');
      assert.deepEqual(f.calls, ['a', 'a', 'a', 'b', 'b', 'b']);
      await f.session.prompt('must remain exhausted');
      assert.equal(f.calls.length, 6);
      const raw = f.session.sessionManager.getBranch().filter(e => e.type === 'message' && e.message.role === 'assistant');
      assert.equal(raw.filter(e => e.type === 'message' && e.message.role === 'assistant' && e.message.provider === 'fixture').length, 6);
    } finally { await f.close(); }
  });
}

test('backup success resets its budget after inherited native retry counter', async () => {
  const f = await fixture(attempt => attempt === 1 ? 'insufficient_quota' : '503 service unavailable', pi => installFallback(pi, config()), attempt => attempt === 6 || attempt === 9 ? 'success' : 'error');
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('backup recovers');
    assert.deepEqual(f.calls, ['a', 'a', 'a', 'b', 'b', 'b']);
    await f.session.prompt('backup gets a fresh budget');
    assert.deepEqual(f.calls, ['a', 'a', 'a', 'b', 'b', 'b', 'b', 'b', 'b']);
  } finally { await f.close(); }
});

for (const mode of ['steer', 'followUp'] as const) {
  test(`queued ${mode} preserves failed-draft omission and exact budget`, async () => {
    const f = await fixture(attempt => attempt === 1 ? 'insufficient_quota' : '503 service unavailable', pi => {
      installFallback(pi, config());
      let queued = false;
      pi.on('message_end', event => {
        if (!queued && event.message.role === 'assistant') {
          queued = true;
          pi.sendUserMessage('queued instruction', { deliverAs: mode });
        }
      });
    });
    try {
      await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
      await f.session.prompt('original instruction');
      assert.deepEqual(f.calls, mode === 'steer' ? ['a', 'a', 'a', 'b'] : ['a', 'a', 'a', 'b', 'b']);
      const last = f.projections.at(-1) as Array<{ role: string; stopReason?: string; content: unknown }>;
      assert.equal(last.filter(m => m.stopReason === 'error').length, 0);
      assert.equal(last.filter(m => m.role === 'user').length, 2);
      assert.equal(f.session.state.messages.filter(m => m.role === 'user').length, 2);
    } finally { await f.close(); }
  });
}

test('standalone abort during quota backoff stops without advancing', async () => {
  let secondContext!: () => void;
  const entered = new Promise<void>(resolve => { secondContext = resolve; });
  const f = await fixture('insufficient_quota', pi => {
    installFallback(pi, config());
    pi.on('turn_end', () => { secondContext(); });
  });
  try {
    f.settings.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000, provider: { maxRetries: 0 } } });
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    const running = f.session.prompt('cancel backoff');
    await entered;
    await delay(10);
    assert.deepEqual(f.calls, ['a']);
    await f.session.abort();
    await running;
    assert.deepEqual(f.calls, ['a']);
  } finally { await f.close(); }
});

test('unavailable auth skips only explicit targets; cross-provider dispatch is exact', async () => {
  const policy = parseConfig({ version: 1, chains: { probe: [
    { provider: 'no-auth', model: 'b', effort: 'off' },
    { provider: 'other', model: 'b', effort: 'off' },
  ] } });
  const f = await fixture('insufficient_quota', pi => installFallback(pi, policy));
  try {
    f.runtime.registerProvider('no-auth', { ...f.provider, apiKey: undefined });
    f.runtime.registerProvider('other', f.provider);
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('explicit cross provider');
    assert.deepEqual(f.dispatches, [{ provider: 'other', model: 'b', effort: undefined }]);
    const state = f.session.sessionManager.getBranch().findLast(e => e.type === 'custom' && e.customType === 'model-fallback.state.v1');
    assert.ok(JSON.stringify(state).includes('no configured authentication'));
    assert.ok(!JSON.stringify(state).includes('fixture-not-a-secret'));
  } finally { await f.close(); }
});

test('an unauthorized missing backup blocks before any primary dispatch', async () => {
  const f = await fixture('insufficient_quota', pi => installFallback(pi, config(['a', 'missing', 'b'])));
  try {
    f.session.setScopedModels([{ model: f.runtime.getModel('fixture', 'a')! }]);
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('reject full chain');
    assert.deepEqual(f.calls, []);
    assert.ok(JSON.stringify(f.session.state.messages).includes('Unauthorized scoped target'));
  } finally { await f.close(); }
});

for (const kind of ['scope', 'effort', 'virtual'] as const) {
  test(`invalid ${kind} is not a skippable backup`, async () => {
    const policy = kind === 'effort' ? parseConfig({ version: 1, chains: { probe: [
      { provider: 'fixture', model: 'a', effort: 'off' }, { provider: 'fixture', model: 'b', effort: 'high' },
    ] } }) : kind === 'virtual' ? parseConfig({ version: 1, chains: { probe: [{ provider: 'fallback', model: 'other', effort: 'off' }] } }) : config();
    const f = await fixture('insufficient_quota', pi => {
      installFallback(pi, policy);
      if (kind === 'virtual') pi.registerVirtualModel({ provider: 'fallback', id: 'other', name: 'Forbidden virtual target', route: (_r, ctx) => ({ model: ctx.modelRegistry.find('fixture', 'b')!, thinkingLevel: 'off' }) });
    });
    try {
      if (kind === 'scope') f.session.setScopedModels([{ model: f.runtime.getModel('fixture', 'a')! }, { model: f.runtime.getModel('fixture', 'b')!, thinkingLevel: 'high' }]);
      await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
      await f.session.prompt('must reject');
      assert.deepEqual(f.calls, []);
    } finally { await f.close(); }
  });
}

test('live scope revocation during native backoff blocks instead of advancing', async () => {
  const f = await fixture('503 service unavailable', pi => installFallback(pi, config()));
  let revoked = false;
  f.session.subscribe(event => {
    if (event.type === 'auto_retry_start' && !revoked) {
      revoked = true;
      f.session.setScopedModels([{ model: f.runtime.getModel('fixture', 'b')! }]);
    }
  });
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('revoke');
    assert.deepEqual(f.calls, ['a']);
    assert.ok(JSON.stringify(f.session.state.messages).includes('Unauthorized scoped target'));
  } finally { await f.close(); }
});

for (const retry of [
  { enabled: false, maxRetries: 2 }, { enabled: true, maxRetries: 3 },
  { enabled: true, maxRetries: 2, provider: { maxRetries: 1 } },
]) {
  test(`incompatible retry settings fail before dispatch: ${JSON.stringify(retry)}`, async () => {
    const f = await fixture('insufficient_quota', pi => installFallback(pi, config()));
    try {
      f.settings.applyOverrides({ retry });
      const before = f.settings.getSettings();
      await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
      await f.session.prompt('setup must fail');
      assert.deepEqual(f.calls, []);
      assert.deepEqual(f.settings.getSettings(), before);
    } finally { await f.close(); }
  });
}

test('image-incompatible targets are skipped without placeholder conversion', async () => {
  const f = await fixture('insufficient_quota', pi => installFallback(pi, config()));
  try {
    f.settings.applyOverrides({ images: { autoResize: false } });
    f.runtime.registerProvider('fixture', { ...f.provider, models: f.provider.models!.map(model => ({ ...model, input: model.id === 'b' ? ['text', 'image'] : ['text'] })) });
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('describe image', { images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=' }] });
    assert.deepEqual(f.calls, ['b']);
    assert.ok(JSON.stringify(f.projections[0]).includes('"type":"image"'));
    assert.ok(!JSON.stringify(f.projections[0]).includes('Image omitted'));
  } finally { await f.close(); }
});

test('physical selection is unaffected, even with incompatible fallback settings', async () => {
  const f = await fixture('insufficient_quota', pi => installFallback(pi, config()));
  try {
    f.settings.applyOverrides({ retry: { enabled: false } });
    await f.session.prompt('physical pinned');
    assert.deepEqual(f.calls, ['a']);
    assert.equal(f.session.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'model-fallback.state.v1').length, 0);
  } finally { await f.close(); }
});

test('two concurrent sessions isolate their sticky target and reset state', async () => {
  const a = await fixture('insufficient_quota', pi => installFallback(pi, config()));
  const b = await fixture('insufficient_quota', pi => installFallback(pi, config()), () => 'success');
  try {
    await Promise.all([a.session.setModel(a.runtime.getModel('fallback', 'probe')!), b.session.setModel(b.runtime.getModel('fallback', 'probe')!)]);
    await Promise.all([a.session.prompt('fall back'), b.session.prompt('stay primary')]);
    assert.deepEqual(a.calls, ['a', 'a', 'a', 'b']);
    assert.deepEqual(b.calls, ['a']);
    await a.session.prompt('/fallback-reset');
    await b.session.prompt('still primary');
    assert.deepEqual(b.calls, ['a', 'a']);
    assert.equal(a.calls.length, 4);
  } finally { await Promise.all([a.close(), b.close()]); }
});

test('reset affects only its branch; tree navigation restores primary versus backup', async () => {
  const f = await fixture('insufficient_quota', pi => installFallback(pi, config()));
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('fall back');
    const backup = f.session.sessionManager.getLeafId()!;
    await f.session.prompt('/fallback-reset');
    const primary = f.session.sessionManager.getLeafId()!;
    assert.notEqual(primary, backup);
    await f.session.navigateTree(backup, { summarize: false });
    await f.session.prompt('backup branch');
    assert.deepEqual(f.calls, ['a', 'a', 'a', 'b', 'b']);
    await f.session.navigateTree(primary, { summarize: false });
    await f.session.reload();
    await f.session.prompt('reset branch');
    assert.deepEqual(f.calls.slice(5), ['a', 'a', 'a', 'b']);
  } finally { await f.close(); }
});

test('configuration changes cannot remap a persisted route without reset', async () => {
  let policy = config();
  const f = await fixture('insufficient_quota', pi => installFallback(pi, policy));
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('fall back');
    policy = config(['b', 'a']);
    await f.session.reload();
    await f.session.prompt('must require reset');
    assert.equal(f.calls.length, 4);
    assert.ok(JSON.stringify(f.session.state.messages).includes('chain changed'));
    await f.session.prompt('/fallback-status');
    assert.equal(f.calls.length, 4);
    await f.session.prompt('/fallback-reset');
    assert.equal(f.calls.length, 4);
    await f.session.prompt('new primary');
    assert.deepEqual(f.calls, ['a', 'a', 'a', 'b', 'b']);
  } finally { await f.close(); }
});

test('failed direct calls do not initialize or increment ordinary routing state', async () => {
  let ctx!: ExtensionContext;
  const f = await fixture('insufficient_quota', pi => {
    installFallback(pi, config());
    pi.registerCommand('direct-probe', { description: 'test', handler: async (_a, context) => { ctx = context; } });
  });
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('/direct-probe');
    const before = f.session.sessionManager.getBranch();
    const result = await ctx.modelRegistry.streamSimple(f.runtime.getModel('fallback', 'probe')!, { messages: [{ role: 'user', content: 'direct failure', timestamp: Date.now() }] }).result();
    assert.equal(result.stopReason, 'error');
    assert.deepEqual(f.session.sessionManager.getBranch(), before);
    await f.session.prompt('ordinary budget unchanged');
    assert.deepEqual(f.calls, ['a', 'a', 'a', 'a', 'b']);
  } finally { await f.close(); }
});

test('ambiguous authentication/transient response is terminal, never recovered', async () => {
  const f = await fixture('401 unauthorized: server overloaded', pi => installFallback(pi, config()));
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('stop');
    assert.deepEqual(f.calls, ['a']);
  } finally { await f.close(); }
});

test('persisted backup is restored by a newly constructed SDK session', async () => {
  const f = await fixture('insufficient_quota', pi => installFallback(pi, config()));
  let resumed: typeof f.session | undefined;
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('persist backup');
    const file = f.session.sessionManager.getSessionFile()!;
    f.session.dispose();
    const loader = new DefaultResourceLoader({ cwd: f.dir, agentDir: f.dir, settingsManager: f.settings,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [pi => installFallback(pi, config())] });
    await loader.reload();
    resumed = (await createAgentSession({ cwd: f.dir, agentDir: f.dir, modelRuntime: f.runtime, settingsManager: f.settings,
      resourceLoader: loader, sessionManager: SessionManager.open(file), tools: [] })).session;
    assert.equal(resumed.model?.provider, 'fallback');
    assert.equal(resumed.model?.id, 'probe');
    await resumed.prompt('restored');
    assert.deepEqual(f.calls, ['a', 'a', 'a', 'b', 'b']);
  } finally { resumed?.dispose(); await f.close(); }
});

test('all missing backups latch exhaustion without corrupting target identity', async () => {
  const f = await fixture(attempt => attempt === 1 ? 'insufficient_quota' : '503 service unavailable', pi => installFallback(pi, config(['a', 'missing'])));
  try {
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('exhaust then skip');
    assert.deepEqual(f.calls, ['a', 'a', 'a']);
    const state = f.session.sessionManager.getBranch().findLast(e => e.type === 'custom' && e.customType === 'model-fallback.state.v1');
    assert.ok(state?.type === 'custom');
    assert.equal((state.data as { failures: number }).failures, 3);
    await f.session.prompt('remain exhausted');
    assert.equal(f.calls.length, 3);
    assert.ok(JSON.stringify(f.session.state.messages).includes('chain exhausted'));
    assert.ok(!JSON.stringify(f.session.state.messages).includes('chain changed'));
  } finally { await f.close(); }
});

test('exact configured effort and real physical identity are retained', async () => {
  const policy = parseConfig({ version: 1, chains: { probe: [
    { provider: 'fixture', model: 'a', effort: 'low' }, { provider: 'fixture', model: 'b', effort: 'high' },
  ] } });
  const f = await fixture('insufficient_quota', pi => installFallback(pi, policy));
  try {
    f.runtime.registerProvider('fixture', { ...f.provider, models: f.provider.models!.map(model => ({ ...model, reasoning: true })) });
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('exact efforts');
    assert.deepEqual(f.dispatches.map(d => d.effort), ['low', 'low', 'low', 'high']);
    const raw = f.session.sessionManager.getBranch().filter(e => e.type === 'message' && e.message.role === 'assistant');
    for (const entry of raw) {
      assert.ok(entry.type === 'message' && entry.message.role === 'assistant');
      assert.equal(entry.message.provider, 'fixture');
      assert.equal(entry.message.thinkingLevel, entry.message.model === 'a' ? 'low' : 'high');
    }
  } finally { await f.close(); }
});

test('busy operator reset is rejected without changing the in-flight budget', async () => {
  let failed!: () => void;
  const firstFailure = new Promise<void>(resolve => { failed = resolve; });
  const f = await fixture('insufficient_quota', pi => {
    installFallback(pi, config());
    pi.on('turn_end', () => { failed(); });
  });
  try {
    f.settings.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000, provider: { maxRetries: 0 } } });
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    const running = f.session.prompt('busy');
    await firstFailure;
    await delay(5);
    const statesBefore = f.session.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'model-fallback.state.v1');
    await f.session.prompt('/fallback-reset');
    assert.deepEqual(f.session.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'model-fallback.state.v1'), statesBefore);
    await f.session.abort();
    await running;
    assert.deepEqual(f.calls, ['a']);
  } finally { await f.close(); }
});

test('terminal backup authentication failure does not skip to another provider', async () => {
  const f = await fixture(attempt => attempt <= 3 ? 'insufficient_quota' : '403 permission denied: server overloaded', pi => installFallback(pi, config(['a', 'b', 'c'])), () => 'error');
  try {
    f.runtime.registerProvider('fixture', { ...f.provider, models: [...f.provider.models!, { ...f.provider.models![1], id: 'c', name: 'c' }] });
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('backup permission failure');
    assert.deepEqual(f.calls, ['a', 'a', 'a', 'b']);
  } finally { await f.close(); }
});

test('image-incompatible chain stops with a capability skip, not forced conversion', async () => {
  const f = await fixture('insufficient_quota', pi => installFallback(pi, config(['a'])));
  try {
    f.settings.applyOverrides({ images: { autoResize: false } });
    await f.session.setModel(f.runtime.getModel('fallback', 'probe')!);
    await f.session.prompt('image', { images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=' }] });
    assert.deepEqual(f.calls, []);
    const state = f.session.sessionManager.getBranch().findLast(e => e.type === 'custom' && e.customType === 'model-fallback.state.v1');
    assert.ok(state?.type === 'custom');
    assert.equal((state.data as { exhausted: boolean }).exhausted, true);
    assert.ok(JSON.stringify(state).includes('image input unsupported'));
  } finally { await f.close(); }
});
