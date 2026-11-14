import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Optional local acceptance only. No import, install or CI dependency on the other repository.
const checkout = process.env.PI_SUBAGENTS_CHECKOUT;
interface Child {
  id: string;
  generation: number;
  status: string;
  disposed: boolean;
  fallback?: { index: number; failures: number; exhausted: boolean };
}

test(
  "actual standalone + subagents keep parent A/B and profile C/D independent",
  { skip: !checkout, timeout: 45_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "fallback-coexistence-"));
    const agentDir = join(root, "agent");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    const errors: unknown[] = [];
    const dispatches: string[] = [];
    const children: Child[] = [];
    try {
      await mkdir(agentDir);
      process.env.PI_CODING_AGENT_DIR = agentDir;
      await writeFile(
        join(agentDir, "model-fallback.json"),
        JSON.stringify({
          version: 1,
          chains: {
            parent: ["a", "b"].map((model) => ({ provider: "coexist", model, effort: "off" })),
          },
        }),
      );
      const targets = ["c", "d"].map((id) => ({ provider: "coexist", id, effort: "off" }));
      await writeFile(
        join(agentDir, "delegation.json"),
        JSON.stringify({
          general: { tools: ["read"], models: targets, fallback: targets, spawn: [] },
        }),
      );
      const settings = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, provider: { maxRetries: 0 } },
      });
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(agentDir, "models-store.json"),
        refreshOnCreate: false,
      });
      const provider = fauxProvider({
        provider: "coexist",
        models: ["a", "b", "c", "d"].map((id) => ({
          id,
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 1024,
        })),
        tokensPerSecond: 0,
      });
      let delegated = false;
      provider.setResponses(
        Array.from({ length: 20 }, () => (_context, _options, _state, model) => {
          dispatches.push(model.id);
          if (model.id === "a" || model.id === "c")
            return fauxAssistantMessage("honest failed draft", {
              stopReason: "error",
              errorMessage: "503 service unavailable",
            });
          if (model.id === "b" && !delegated) {
            delegated = true;
            return fauxAssistantMessage(
              fauxToolCall("delegate_task", {
                profile: "general",
                assignment: "controlled child task",
                background: false,
                limits: { requests: 8, tools: 1, spawns: 0 },
              }),
              { stopReason: "toolUse" },
            );
          }
          return fauxAssistantMessage(
            model.id === "d" ? "child recovered on D" : "parent remains on B",
          );
        }),
      );
      runtime.registerNativeProvider(provider.provider);
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
        noContextFiles: true,
        additionalExtensionPaths: [resolve("src/index.ts"), join(resolve(checkout!), "index.ts")],
        extensionFactories: [
          (pi) => {
            pi.events.on("delegation:registry", (event) => {
              const value = event as { child?: Child };
              if (value.child) children.push(structuredClone(value.child));
            });
          },
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      session = (
        await createAgentSession({
          cwd: root,
          agentDir,
          modelRuntime: runtime,
          resourceLoader: loader,
          model: runtime.getModel("coexist", "a")!,
          settingsManager: settings,
          sessionManager: SessionManager.create(root, join(root, "sessions")),
          tools: ["read", "delegate_task", "delegate_coordinate"],
        })
      ).session;
      await session.bindExtensions({
        mode: "print",
        onError: (error) => {
          errors.push(error);
        },
      });
      await session.setModel(runtime.getModel("fallback", "parent")!);
      await session.prompt("fall back then delegate");
      assert.deepEqual(errors, []);
      assert.deepEqual(dispatches, ["a", "a", "a", "b", "c", "c", "c", "d", "b"]);
      const child = children.at(-1)!;
      assert.equal(child.status, "settled");
      assert.equal(child.disposed, true);
      assert.equal(child.fallback?.index, 1);
      assert.equal(child.fallback?.failures, 0);
      const parentState = () =>
        session!.sessionManager
          .getBranch()
          .findLast((e) => e.type === "custom" && e.customType === "model-fallback.state.v1");
      const index = () => {
        const entry = parentState();
        assert.ok(entry?.type === "custom");
        return (entry.data as { index: number }).index;
      };
      assert.equal(index(), 1);
      const beforeReset = dispatches.length;
      await session.prompt("/fallback-reset");
      assert.equal(dispatches.length, beforeReset);
      assert.equal(index(), 0);
      assert.equal(children.at(-1)!.fallback?.index, 1, "parent reset must not reset child D");
      await session.prompt("parent recovers again");
      assert.deepEqual(dispatches.slice(beforeReset), ["a", "a", "a", "b"]);
      assert.equal(index(), 1);
      const beforeChildReset = dispatches.length;
      await session.prompt(`/subagent-fallback-reset ${child.id} ${child.generation}`);
      assert.deepEqual(errors, []);
      assert.equal(dispatches.length, beforeChildReset);
      assert.equal(children.at(-1)!.fallback?.index, 0, "child reset restores C");
      assert.equal(index(), 1, "child reset must not reset parent B");
      await session.prompt("parent still B after child reset");
      assert.deepEqual(dispatches.slice(beforeChildReset), ["b"]);
      assert.equal(children.at(-1)!.fallback?.index, 0);
      console.log(
        JSON.stringify({
          dispatches,
          child: { id: child.id, generation: child.generation, status: child.status },
          parentIndex: index(),
          childIndex: children.at(-1)!.fallback?.index,
        }),
      );
    } finally {
      if (session) {
        await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  },
);
