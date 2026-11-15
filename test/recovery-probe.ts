import { setTimeout as delay } from 'node:timers/promises';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// Deliberately scoped SDK probe, not a shippable policy/configuration implementation.
export function recoveryProbe(pi: ExtensionAPI, backoffMs = 1, onBackoff?: () => void) {
  type State = { active: string; failures: number; pending: boolean };
  const read = (ctx: ExtensionContext): State => {
    const entry = ctx.sessionManager.getBranch().findLast(e => e.type === 'custom' && e.customType === 'probe.route');
    return entry?.type === 'custom' ? entry.data as State : { active: 'a', failures: 0, pending: false };
  };
  pi.registerVirtualModel({ provider: 'fallback', id: 'probe', name: 'SDK probe',
    async route(request, ctx) {
      let state = read(ctx);
      if (request.reason !== 'direct' && state.pending) {
        onBackoff?.();
        await delay(backoffMs, undefined, { signal: request.signal });
        state = { ...state, pending: false };
        pi.appendEntry('probe.route', state);
      }
      return { model: ctx.modelRegistry.find('fixture', state.active)!, thinkingLevel: 'off' };
    },
  });
  pi.on('turn_end', (event, ctx) => {
    const state = read(ctx);
    const failures = event.message.role === 'assistant' && event.message.stopReason === 'error' ? state.failures + 1 : 0;
    return { entries: [...event.entries, { type: 'custom', customType: 'probe.route', data: { ...state, failures } }] };
  });
  pi.on('agent_before_settle', (event, ctx) => {
    const last = ctx.sessionManager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'assistant');
    if (last?.type !== 'message' || last.message.role !== 'assistant' || last.message.stopReason !== 'error') return;
    const state = read(ctx);
    if (state.active === 'b') return;
    return { entries: [...event.entries,
      { type: 'context_edit', targetId: last.id, replacement: null },
      { type: 'custom', customType: 'probe.route', data: { active: state.failures >= 3 ? 'b' : 'a', failures: state.failures >= 3 ? 0 : state.failures, pending: true } },
    ], continue: true };
  });
  pi.registerCommand('probe-reset', { description: 'Probe only', handler: async (_args, ctx) => {
    assertIdle(ctx);
    pi.appendEntry('probe.route', { active: 'a', failures: 0, pending: false });
  } });
}
function assertIdle(ctx: ExtensionContext) { if (!ctx.isIdle()) throw new Error('Reset requires idle'); }
