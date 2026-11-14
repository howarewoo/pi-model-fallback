import { createHash } from 'node:crypto';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

export interface Target { provider: string; model: string; effort: ModelThinkingLevel }
export interface Config { version: 1; chains: Record<string, Target[]> }
const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown model-fallback configuration field');
}
export function parseConfig(value: unknown): Config {
  if (!object(value) || value.version !== 1 || !object(value.chains)) throw new Error('Expected model-fallback version 1 and named chains');
  keys(value, ['version', 'chains']);
  const chains: Record<string, Target[]> = Object.create(null);
  for (const [name, entries] of Object.entries(value.chains)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name) || !Array.isArray(entries) || !entries.length) throw new Error(`Invalid or empty chain: ${name}`);
    const seen = new Set<string>();
    chains[name] = entries.map(entry => {
      if (!object(entry)) throw new Error(`Invalid target in ${name}`);
      keys(entry, ['provider', 'model', 'effort']);
      if (typeof entry.provider !== 'string' || !entry.provider.trim() || typeof entry.model !== 'string' || !entry.model.trim() || typeof entry.effort !== 'string' || !levels.has(entry.effort)) throw new Error(`Expected exact provider/model/effort in ${name}`);
      if (/[\s*?\[\]{}]/.test(entry.provider) || /[\s*?\[\]{}]/.test(entry.model)) throw new Error(`Targets must be exact, not patterns: ${name}`);
      const target: Target = { provider: entry.provider, model: entry.model, effort: entry.effort as ModelThinkingLevel };
      const id = JSON.stringify([target.provider, target.model, target.effort]);
      if (seen.has(id)) throw new Error(`Duplicate target in ${name}`);
      seen.add(id);
      return { provider: target.provider, model: target.model, effort: target.effort };
    });
  }
  if (!Object.keys(chains).length) throw new Error('At least one named chain is required');
  return { version: 1, chains };
}
export function fingerprint(targets: Target[]): string {
  return createHash('sha256').update(JSON.stringify(targets)).digest('hex');
}
export const identity = (target: Target) => `${target.provider}/${target.model}:${target.effort}`;
