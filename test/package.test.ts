import assert from 'node:assert/strict';
import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
function exec(command: string, args: string[], options: ExecFileOptionsWithStringEncoding = { encoding: 'utf8' }) {
  const pending = execFileAsync(command, args, { timeout: 30_000, encoding: 'utf8', ...options });
  // Print mode reads piped stdin even with an explicit prompt.
  pending.child.stdin?.end();
  return pending;
}
const cli = resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');

test('tarball installs without host copies and loads/runs in real Pi 1.5.2', { timeout: 60_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'fallback-package-'));
  try {
    const agent = join(temp, 'agent');
    const consumer = join(temp, 'consumer');
    await mkdir(agent);
    await mkdir(consumer);
    const packed = await exec('npm', ['pack', '--json', '--pack-destination', temp]);
    const metadata = JSON.parse(packed.stdout)[0] as { filename: string; files: Array<{ path: string }> };
    assert.ok(metadata.files.some(file => file.path === 'src/index.ts'));
    assert.ok(!metadata.files.some(file => file.path.includes('node_modules') || file.path.startsWith('test/')));
    await exec('npm', ['install', '--prefix', consumer, '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', join(temp, metadata.filename)]);
    const installed = join(consumer, 'node_modules/@howarewoo/pi-model-fallback');
    const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.pi.extensions, ['./src/index.ts']);
    assert.equal(manifest.dependencies, undefined);
    await assert.rejects(readFile(join(consumer, 'node_modules/@earendil-works/pi-coding-agent/package.json')));
    const env = { ...process.env, PI_CODING_AGENT_DIR: agent };
    await writeFile(join(agent, 'model-fallback.json'), JSON.stringify({ version: 1, chains: { work: [
      { provider: 'fixture', model: 'a', effort: 'off' }, { provider: 'fixture', model: 'b', effort: 'off' },
    ] } }));
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, provider: { maxRetries: 0 } }, compaction: { enabled: false } }));
    const installedPi = await exec(process.execPath, [cli, 'install', installed], { cwd: temp, env });
    assert.ok((installedPi.stdout + installedPi.stderr).includes('Installed'));
    const settings = JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8'));
    assert.ok(JSON.stringify(settings.packages).includes('pi-model-fallback'));
    const listed = await exec(process.execPath, [cli, '--offline', '--list-models', 'fallback'], { cwd: temp, env });
    assert.match(listed.stdout, /fallback\s+work/);
    assert.ok(!listed.stderr.includes('Failed to load'));
    const fixture = join(temp, 'fixture.ts');
    await writeFile(fixture, `
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync } from 'node:fs';
export default function(pi) {
  pi.registerProvider('fixture', {
    api: 'openai-completions', apiKey: 'fixture-only', baseUrl: 'https://invalid.example',
    models: ['a', 'b'].map(id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model) {
      appendFileSync(${JSON.stringify(join(temp, 'dispatches'))}, model.id + '\\n');
      const failed = model.id === 'a';
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [{ type: 'text', text: failed ? 'failed draft' : 'package recovery succeeded' }], stopReason: failed ? 'error' : 'stop', ...(failed ? { errorMessage: 'insufficient_quota' } : {}), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: message });
      stream.push(failed ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    }
  });
}
`);
    const run = await exec(process.execPath, [cli, '--offline', '--no-session', '--no-builtin-tools', '-e', fixture, '--model', 'fallback/work', '-p', 'Recover with the installed package'], { cwd: temp, env });
    assert.match(run.stdout, /package recovery succeeded/);
    assert.equal(await readFile(join(temp, 'dispatches'), 'utf8'), 'a\na\na\nb\n');
    assert.ok(!run.stderr.includes('Extension Error'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
