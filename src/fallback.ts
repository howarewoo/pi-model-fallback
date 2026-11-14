import { setTimeout as delay } from 'node:timers/promises';
import { getSupportedThinkingLevels, isContextOverflow, isRetryableAssistantError, retryDelayMs, type AssistantMessage, type Model, type Message } from '@earendil-works/pi-ai';
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { fingerprint, identity, type Config } from './config.ts';

const ENTRY = 'model-fallback.state.v1';
const RETRIES = 2;
interface State {
  version: 1; chain: string; fingerprint: string; index: number; target: string;
  failures: number; lastEntryId?: string; exhausted: boolean; pendingDelay: boolean; warnedCapabilities?: boolean;
  skipped: { target: string; reason: string }[];
}
function eligible(message: AssistantMessage): boolean {
  if (message.stopReason !== 'error' || isContextOverflow(message)) return false;
  const error = message.errorMessage ?? '';
  // Terminal failures must win over ambiguous gateway text mentioning transient errors.
  if (/\b(400|401|403|404|405|422)\b|unauthori[sz]ed|authentication|permission|access.denied|forbidden|invalid.request|refusal|content.policy|cancel|abort/i.test(error)) return false;
  return isRetryableAssistantError(message) || /connection reset|socket hang up|premature close|interrupted stream|network error|insufficient_quota|quota (?:exceeded|exhausted)|exhausted quota|out of (?:budget|credits)|(?:insufficient|exhausted) credits|credits exhausted|credit balance|payment required|billing|usage.limit|usage limit|available balance|GoUsageLimitError|FreeUsageLimitError/i.test(error);
}
function hasImages(messages: readonly Message[]): boolean {
  return messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image'));
}

export function installFallback(pi: ExtensionAPI, config: Config) {
  const selected = (ctx: ExtensionContext) => ctx.model?.provider === 'fallback' && config.chains[ctx.model.id] ? ctx.model.id : undefined;
  const fresh = (chain: string): State => ({ version: 1, chain, fingerprint: fingerprint(config.chains[chain]), index: 0, target: identity(config.chains[chain][0]), failures: 0, exhausted: false, pendingDelay: false, skipped: [] });
  function read(ctx: ExtensionContext, chain: string, allowMismatch = false): State {
    const entry = ctx.sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === ENTRY && (entry.data as Partial<State> | undefined)?.chain === chain);
    if (!entry || entry.type !== 'custom') return fresh(chain);
    const state = entry.data as State;
    if (state.version !== 1 || !Number.isInteger(state.index) || state.index < 0 || !Number.isInteger(state.failures) || state.failures < 0 || state.failures > RETRIES + 1 || typeof state.exhausted !== 'boolean' || typeof state.pendingDelay !== 'boolean' || !Array.isArray(state.skipped)) throw new Error('Invalid persisted fallback state; manual reset required');
    if (!allowMismatch && (state.fingerprint !== fingerprint(config.chains[chain]) || !config.chains[chain][state.index] || state.target !== identity(config.chains[chain][state.index]))) throw new Error('Fallback chain changed; manual reset required');
    return state;
  }
  const save = (state: State) => pi.appendEntry(ENTRY, state);
  function setup() {
    const retry = pi.getSettings().retry;
    if (retry?.enabled === false || retry?.maxRetries !== RETRIES || (retry?.provider?.maxRetries ?? 0) !== 0) throw new Error('Fallback requires retry.enabled=true, retry.maxRetries=2 and retry.provider.maxRetries=0; settings were not changed');
  }
  function validate(ctx: ExtensionContext, chain: string) {
    for (const target of config.chains[chain]) {
      const model = ctx.modelRegistry.find(target.provider, target.model);
      if (model?.api === 'pi-virtual') throw new Error(`Virtual target is forbidden: ${identity(target)}`);
      if (ctx.scopedModels.length && !ctx.scopedModels.some(scope => scope.model.provider === target.provider && scope.model.id === target.model && (!scope.thinkingLevel || scope.thinkingLevel === target.effort))) throw new Error(`Unauthorized scoped target: ${identity(target)}`);
      if (model && !getSupportedThinkingLevels(model).includes(target.effort)) throw new Error(`Unsupported exact effort: ${identity(target)}`);
      if (model && (!(model.contextWindow > 0) || !(model.maxTokens > 0))) throw new Error(`Unknown model limits: ${identity(target)}`);
    }
  }
  function available(ctx: ExtensionContext, chain: string, state: State, messages: readonly Message[], activeOnly = false): { state: State; model?: Model<string> } {
    const targets = config.chains[chain];
    const skipped = [...state.skipped];
    for (let index = state.index; index < (activeOnly ? Math.min(state.index + 1, targets.length) : targets.length); index++) {
      const target = targets[index];
      const model = ctx.modelRegistry.find(target.provider, target.model);
      let reason: string | undefined;
      if (!model) reason = 'missing catalog model';
      else if (!ctx.modelRegistry.hasConfiguredAuth(model)) reason = 'no configured authentication';
      else if (hasImages(messages) && !model.input.includes('image')) reason = 'image input unsupported';
      if (reason) { skipped.push({ target: identity(target), reason }); continue; }
      return { model: model!, state: { ...state, index, target: identity(target), failures: index === state.index ? state.failures : 0, skipped } };
    }
    return { state: { ...state, exhausted: true, skipped } };
  }
  for (const [chain, targets] of Object.entries(config.chains)) {
    pi.registerVirtualModel({ provider: 'fallback', id: chain, name: `Fallback: ${chain}`, input: ['text', 'image'],
      async route(request, ctx) {
        if (request.reason !== 'direct') setup();
        validate(ctx, chain);
        let state = read(ctx, chain);
        const previous = state;
        if (state.exhausted) throw new Error('Fallback chain exhausted; /fallback-reset required');
        // Native retry counters can carry across targets or restart after a quota
        // continuation. The persisted physical-target budget is authoritative.
        if (request.reason !== 'direct' && state.failures >= RETRIES + 1) {
          if (state.index + 1 === targets.length) {
            save({ ...state, exhausted: true, pendingDelay: false });
            throw new Error('Fallback chain exhausted; /fallback-reset required');
          }
          state = { ...state, index: state.index + 1, target: identity(targets[state.index + 1]), failures: 0 };
        }
        if (request.reason === 'retry' && request.failed && !eligible(request.failed.message) && !isContextOverflow(request.failed.message)) throw new Error('Fallback stopped: failed response is not eligible for recovery');
        if (request.reason !== 'direct' && state.pendingDelay && request.reason !== 'retry') {
          const retry = pi.getSettings().retry;
          await delay(retryDelayMs({ baseDelayMs: retry?.baseDelayMs ?? 2000, maxAgentDelayMs: retry?.maxAgentDelayMs ?? 60000 }, Math.max(1, state.failures)), undefined, { signal: request.signal });
          // Settings/scopes/auth may have changed while the cancellable wait ran.
          setup();
          validate(ctx, chain);
        }
        request.signal?.throwIfAborted();
        const result = available(ctx, chain, state, request.messages, request.reason === 'direct');
        state = result.state;
        if (!result.model) {
          if (request.reason !== 'direct') save({ ...state, index: previous.index, target: previous.target, failures: previous.failures, pendingDelay: false });
          throw new Error('No available authorized fallback targets; /fallback-reset required');
        }
        if (request.reason !== 'direct') {
          const capabilities = targets.map(target => ctx.modelRegistry.find(target.provider, target.model)).filter(model => !!model).map(model => `${model.contextWindow}:${model.input.join(',')}`);
          if (!state.warnedCapabilities && new Set(capabilities).size > 1) {
            const warning = 'Fallback candidates differ in context/image capabilities. Native compaction may run; image-incompatible targets are skipped, not converted.';
            pi.appendEntry('model-fallback.warning', { chain, warning });
            if (ctx.hasUI) ctx.ui.notify(warning, 'warning');
            state = { ...state, warnedCapabilities: true };
          }
          save({ ...state, pendingDelay: false });
        }
        return { model: result.model, thinkingLevel: targets[state.index].effort };
      },
    });
  }
  pi.on('turn_end', (event, ctx) => {
    const chain = selected(ctx);
    if (!chain || event.message.role !== 'assistant') return;
    const state = read(ctx, chain);
    const target = config.chains[chain][state.index];
    if (event.message.provider !== target.provider || event.message.model !== target.model || state.lastEntryId === event.messageEntryId) return;
    const recover = eligible(event.message);
    const successful = event.message.stopReason !== 'error' && event.message.stopReason !== 'aborted';
    return { entries: [...event.entries,
      // Commit omission at the turn boundary too: queued user work can run before
      // final settlement. Never project a failed draft or its partial tool calls.
      ...(recover ? [{ type: 'context_edit' as const, targetId: event.messageEntryId, replacement: null }] : []),
      { type: 'custom', customType: ENTRY, data: { ...state, failures: recover ? state.failures + 1 : successful ? 0 : state.failures, pendingDelay: recover && !isRetryableAssistantError(event.message), lastEntryId: event.messageEntryId } },
    ] };
  });
  pi.on('agent_before_settle', async (event, ctx) => {
    const chain = selected(ctx);
    if (!chain) return;
    const state = read(ctx, chain);
    if (state.exhausted) return;
    const last = ctx.sessionManager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'assistant');
    if (last?.type !== 'message' || last.message.role !== 'assistant' || state.lastEntryId !== last.id || !eligible(last.message)) return;
    setup();
    validate(ctx, chain);
    const exhaustedTarget = state.failures >= RETRIES + 1;
    let next = { ...state, index: state.index + (exhaustedTarget ? 1 : 0), failures: exhaustedTarget ? 0 : state.failures, pendingDelay: true };
    const result = available(ctx, chain, next, event.context.llmMessages);
    next = result.state;
    if (!result.model) return { entries: [...event.entries, { type: 'custom', customType: ENTRY, data: { ...next, index: state.index, target: state.target, failures: state.failures, exhausted: true, pendingDelay: false } }] };
    return { entries: [...event.entries, { type: 'custom', customType: ENTRY, data: next }], continue: true };
  });
  pi.registerCommand('fallback-reset', { description: 'Reset the selected fallback chain on this idle branch (no model call)', handler: async (_args, ctx) => {
    if (!ctx.isIdle()) throw new Error('Fallback reset requires an idle session');
    const chain = selected(ctx);
    if (!chain) throw new Error('Select a fallback/<chain> model first');
    validate(ctx, chain);
    const result = available(ctx, chain, fresh(chain), convertToLlm(ctx.sessionManager.buildSessionProjection().messages));
    save(result.state);
    report(ctx, { chain, state: result.state });
  } });
  pi.registerCommand('fallback-status', { description: 'Show selected branch-local fallback state and setup', handler: async (_args, ctx) => {
    const chain = selected(ctx);
    let problem: string | undefined;
    let state: State | null = null;
    try { if (chain) state = read(ctx, chain, true); setup(); if (chain) { validate(ctx, chain); read(ctx, chain); } } catch (error) { problem = String(error); }
    report(ctx, { chain: chain ?? null, state, problem, warning: 'Failed requests can incur costs; failed-attempt usage may be unknown. Capability/context changes may lose caches or cause native compaction.' });
  } });
  function report(ctx: ExtensionContext, data: unknown) {
    const content = JSON.stringify(data, null, 2);
    if (ctx.hasUI) ctx.ui.notify(content, 'info');
    else pi.sendMessage({ customType: 'model-fallback.status', content, display: true }, { triggerTurn: false });
  }
}
