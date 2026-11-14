# Pi model fallback

Select a named fallback chain in Pi's `/model` picker. Each physical target gets
an initial attempt and **two retries** for eligible provider failures, including
quota/credit exhaustion. If all three fail, Pi tries the next explicitly configured
target. A working backup stays selected for later turns until you manually reset.

This is a standalone main-thread extension: it neither imports nor reads the
configuration or state of a subagent extension. Physical model selections keep
normal Pi behavior. Tested with **Pi 1.5.2 and Node.js 24**; compatibility with other
Pi versions and live provider services is not established by these tests.

## Install and configure

This package has not been published to npm. From a checkout of this version:

```sh
pi install /absolute/path/to/pi-model-fallback
```

Pi supplies the SDK dependencies; an operator installation does not need this
repository's development dependencies. Extensions execute with Pi's operating-system
permissions: review the source before installing.

1. Configure native provider authentication with Pi's `/login` or existing provider
   configuration. This extension does not provision accounts, copy credentials,
   discover new destinations, or read project-local fallback configuration.
2. Create **`~/.pi/agent/model-fallback.json`** (or `model-fallback.json` in the agent
   directory selected by `PI_CODING_AGENT_DIR`). Replace these illustrative IDs
   with exact physical model IDs from your Pi catalogue:

   ```json
   {
     "version": 1,
     "chains": {
       "work": [
         { "provider": "anthropic", "model": "claude-sonnet-4-5", "effort": "high" },
         { "provider": "openai", "model": "gpt-4.1", "effort": "off" }
       ]
     }
   }
   ```

   **Listing a provider authorizes sending the conversation to it.** Cross-provider
   routing is never inferred from your credentials or catalogue. Choose only
   destinations you permit to receive that data.
3. Merge the following prerequisite into your existing Pi `settings.json`; do not
   replace unrelated settings:

   ```json
   {
     "retry": {
       "enabled": true,
       "maxRetries": 2,
       "provider": { "maxRetries": 0 }
     }
   }
   ```

   Native agent retries and provider-level retries are different. The extension
   checks effective settings, including runtime retry toggles, before ordinary
   dispatch and after its backoff. It stops with a diagnostic instead of changing
   your settings. `baseDelayMs` and `maxAgentDelayMs` remain Pi's retry settings;
   defaults are 2-second exponential backoff and a 60-second cap.
4. Start Pi or use `/reload`, open `/model`, and select **`fallback/work`**. In
   print mode, use `pi --model fallback/work -p 'your request'`.
5. Use `/fallback-status` to see the active target, consecutive eligible failure
   count, skipped targets/reasons, exhaustion and setup diagnostics. If a backup
   takes over, subsequent successful turns continue using that backup.
6. When Pi is idle, run `/fallback-reset` to return **only the selected chain on
   the current branch** to its first available authorized target. Reset does not
   send a model request, clear conversation history or reset other sessions.

Configuration changes take effect on reload. If an existing chain changes, its
persisted fingerprint prevents silently reinterpreting an old index. Select that
chain and explicitly reset it after reviewing the new destinations.

## Configuration reference

| Field | Contract |
| --- | --- |
| `version` | Required, exactly `1`. |
| `chains` | Nonempty object of named, nonempty, ordered target arrays. |
| Chain name | Starts with an ASCII letter/digit, followed by letters/digits, `_` or `-`. Appears as `fallback/<name>`. |
| `provider`, `model` | Required exact catalogue IDs. Whitespace and glob-pattern characters are rejected. No automatic discovery of backups. |
| `effort` | Required: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; must be supported by that physical model without clamping. |

Unknown fields (including secrets), duplicate exact provider/model/effort targets,
virtual targets and unsupported efforts are errors. Missing catalogue entries and
absent configured authentication are availability skips, **not** new permissions.
The complete chain is checked against session model/effort scopes before dispatch,
even if an earlier target is missing. If you use `--models` or `enabledModels`,
include every chain target with its allowed effort; scoping only the virtual model
does not authorize its physical targets. A revoked scope stops recovery rather
than skipping to another provider.

## Recovery and safety boundaries

- **Eligible failures:** Pi's public transient provider/transport classifier,
  interrupted connections/streams, and recognized quota/billing/credit-limit
  errors. Error text is provider-dependent; unrecognized failures stop instead
  of guessing. Authentication/permission failures, invalid requests, refusals,
  cancellation and tool failures do not trigger fallback.
- **Exact retry budget:** state tracks failures by physical target, not Pi's
  native retry counter. Native transient retries remain enabled. Before a native
  retry could exceed three attempts, the virtual router advances. Quota and
  remaining-budget recovery use the public settlement boundary. This also gives
  a backup its full two retries when a native counter carries over from a primary.
- **Backoff and cancellation:** boundary recovery defers backoff to the next router
  invocation, where Pi provides a live abort signal. Escape/abort cancels that
  wait; it cannot dispatch another provider request or automatically resume it.
- **Stream/tool safety:** failed drafts remain in raw session history but supported
  `context_edit` entries omit them from future model projection. Incomplete calls
  in a failed draft do not execute; earlier completed tool/result pairs remain and
  their SDK invocations are not replayed. A model may independently request a
  similar action later: this is not an exactly-once external-side-effect guarantee.
- **Capabilities:** unsupported image targets are skipped rather than receiving
  fallback-generated placeholders. A warning records differing context/image
  capabilities. Pi still owns native image preparation and context compaction;
  the extension does not truncate messages to force a fallback to fit. Context
  overflow remains Pi's native recovery, not a fallback-eligible failure.
- **Persistence:** branch-local custom entries store target identity, a chain
  fingerprint, failure count, skips and the exhaustion latch. State survives
  reload, resume, compaction and tree navigation. Sessions and chains do not share
  a health cache. Selecting a physical model suspends this controller.
- **Exhaustion:** no wraparound or provider calls on later requests until manual
  reset. Status retains the final attempted target and failure count.
- **Direct requests:** compaction/summary and third-party direct registry calls use
  the active target read-only. They do not retry/advance the chain, initialize its
  state, or modify its counters. An unavailable active target stops a direct call.
- **Cost and attribution:** retries may incur charges. Native assistant messages
  retain physical provider/model/effort and known usage. Missing failed-attempt
  usage is unknown, not measured zero cost. Status never dumps prompts or keys;
  normal Pi transcript storage still contains the conversation and raw failures.

Status/reset commands have no model-facing tool counterpart. Reset rejects while
busy. In non-UI modes, status/reset responses are structured custom messages;
route decisions, capability warnings and raw errors are available in session
entries. No custom visual dashboard is required.

## Troubleshooting

| Symptom | Check and recovery |
| --- | --- |
| No `fallback/…` entries or commands | Create the agent-directory config, check JSON/version/field names, then `/reload`. No file means the extension registers nothing. Check Pi's extension-load errors. |
| Retry prerequisite diagnostic | Set native retries to two, provider retries to zero and enable the retry toggle; the extension never makes these changes for you. |
| Unauthorized scoped target | Correct the explicit physical model/effort scopes; adding credentials alone does not authorize a destination. |
| Unsupported effort or virtual target | Use exact supported physical selections. These errors are never availability skips. |
| Skipped targets / no available target | Check catalogue IDs, native provider authentication and image support; then reset when appropriate. A runtime 401/403 is terminal, not an availability skip. |
| Chain changed or exhausted | Review `/fallback-status`; reset the selected idle branch explicitly. Reset does not test provider health. |
| Unexpected provider text stops recovery | Keep the raw error for diagnosis. Do not recategorize an auth/permission/request failure as transient merely to get another model call. |

## Contributor verification

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:package
```

Dependencies are pinned to the authoritative registry's Pi 1.5.2 baseline. The SDK
suite uses scripted in-process providers and temporary agent/session directories,
not live models. It retains the original mixed quota→transient regression that
previously dispatched A/A/A/A/B; it now asserts A/A/A/B. Additional cases cover
backup-counter carryover through final exhaustion, success reset, terminal errors,
queued steering/follow-ups, stream/tool safety, scopes/auth/capabilities, cancellation,
branch reset/reload/compaction/resume, concurrent isolation and read-only direct
calls. The image-modality test disables native auto-resize to isolate routing.

The package check packs an npm tarball, installs it without duplicate host SDKs,
uses real Pi 1.5.2 `install` and `/model` catalogue discovery under a temporary agent
directory, then runs A/A/A/B recovery through the installed package in offline
print mode. It changes only temporary settings and cleans them up. The smaller
`test/recovery-probe.ts` is a public-API checkpoint fixture, not shipped runtime.

### Optional local coexistence acceptance

```sh
PI_SUBAGENTS_CHECKOUT=/absolute/path/to/pi-subagents npm run test:coexistence
```

This opt-in SDK fixture loads both actual extension entrypoints from local sources
under one temporary agent directory. The other checkout must already have its own
dependencies installed. The fixture uses public Pi extension loading rather than
cross-repository source/test imports. No package dependency is added, and the check
is skipped without the environment variable; it is not part of required standalone
CI.

Observed against `pi-subagents` commit
`64db91266549e156cbfccd9779b7cfed7b4737b4`: parent A/A/A/B, then a real
`delegate_task` invocation dispatching the profile-owned C/C/C/D, followed by B.
Parent reset leaves the retained child on D; child reset restores C without
resetting parent B or dispatching a provider request. A subsequent parent request
still uses B. Provider streams are controlled, not paid calls. This is a real
local-source coexistence scenario, not a broad installed-version compatibility
matrix. The package has no subagent dependency or routing bridge; each policy
remains independently owned. No paid-provider uptime/account smoke test is claimed.

## Repository and licensing

The package repository is
[`howarewoo/pi-model-fallback`](https://github.com/howarewoo/pi-model-fallback).
Metadata is intentionally `UNLICENSED`: no license grant has been selected or
included. Public repository visibility is not an open-source license. A license
must be selected explicitly before representing this package as licensed for reuse.
