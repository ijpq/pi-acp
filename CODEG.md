# CodeG distribution: 0.0.34-codeg.5

Based on svkozak/pi-acp (MIT), retaining upstream copyright and license.
Requires Node >=22.19.0 and Pi >=1.4.0. CodeG ships a private Node 24.16.0,
Pi 1.4.0 and this adapter as a versioned group; no global npm installation or
credential migration is required.

Runtime diagnostics and the startup version probe the selected RPC executable,
with a bounded timeout; `_pi/identity.runtime` reports its path and verified
version. A custom runtime never borrows a global Pi version or changelog.
This distribution has no global-npm update notice: upgrade the CodeG runtime group.

`session/new` asks Pi to initialize an exclusively allocated empty file, then
compares `get_state` with the native file header before advertising ready.
`load`/`resume` require the mapped file to exist and validate its header and
workspace; missing or conflicting identity is an error, never a new session.
The ACP identity may remain a legacy alias: its explicitly mapped native ID
and file are independent and inspectable with `_pi/identity`. Filenames are
not used to repair identity. Native history is never deleted on initialization
or model discovery failures. Session maps are atomic files per ACP ID; the
old shared map is imported lazily without overwriting it.

The session-scoped bundled extension uses Pi's native `registerMcpServer`.
It accepts ACP stdio and streamable HTTP definitions, including environment
and headers. SSE is unsupported. No user `mcp.json` is changed. Ready requires
the native bridge command to be registered; disabling/replacing the native MCP
extension may prevent CodeG tools and is not presented as a successful tool
connection. Tools use Pi's normal permissions and extension pipeline.

`_session/steering` calls native `steer`, `_pi/follow_up` calls native
`follow_up`; both accept ACP prompt blocks and images. They require an owning
active prompt and never start detached work after a turn-end race. A native
acknowledgement means queued/handled, not proof of execution. The original
prompt stays open through retries and continuations until `agent_settled`.
Cancel clears native queues before abort. Provider errors and process exit
are failures, not successful empty answers.

`session/fork` uses native `clone` on an independent reader, validates the new
identity and leaves the source process and binding unchanged. Only the current
tail is supported; arbitrary AIR fork points are rejected. CodeG's separately
labelled snapshot fallback handles unsupported fork points and unified
multi-engine history. `resume` restores without duplicating replay events.

Actual subagents and deliverable publication are supplied by CodeG's MCP
companion, not by an instruction claiming that Pi spawned a child. Authentication,
models, skills, extensions and workspaces remain owned by the user and are not
copied between engines. CodeG's external-message idempotency and durable queue
are owned by CodeG, not this ACP adapter.

`service_tier` is a separate ACP config option for established GPT/o-series
models on `openai-responses` and `openai-codex-responses`. Pi RPC has no native
tier setter: a bundled native extension uses `before_provider_request` to set
the actual payload's `service_tier` to `default` (off) or `priority` (on).
It does not alter reasoning. Choices are private adapter preferences per
session, provider, model, API and endpoint, independent of Pi credentials.
Changes use a native extension command with a nonce-matched acknowledgement;
the command does not become a user message. Model, thinking and tier changes
are serialized and rejected during an active task. Unsupported interfaces and
models show an unavailable option and reject attempts to enable it.

The last raw `response.completed.response.service_tier` is recorded separately
from the requested value. Missing fields remain unverified; Pi's usage/pricing
fallback to the requested tier is never taken as evidence. For a relay the
field is labelled endpoint-reported, with upstream unverified. A differing
returned tier is shown verbatim. Provider failures do not retry without the
requested tier. No speed or relay billing claim is inferred. The option is off
by default and warns of potentially higher provider/relay charges or quota use.

## Shared canonical skills

Callers may supply `CODEG_SHARED_SKILL_PATHS_JSON`, a launch-only JSON array of explicitly selected Markdown skill directories/files. CodeG does not automatically synchronize another engine’s base configuration or migrate local skills, memory or ledgers in this release. The adapter resolves paths in the session workspace, deduplicates real paths and passes each original through Pi 1.4.0 native `--skill`. It neither copies skills nor reads another engine's authentication, private memories or extensions. Missing optional roots are ignored; malformed/unreadable configured sources fail explicitly. Pi's own skills and trust settings remain in place; native name collisions retain Pi's documented first source and diagnostics. CodeG delivers shared rules independently of handoff; ledger/skill bodies are read from their canonical paths on demand.

## Native compaction lifecycle

Pi 1.4 emits `compaction_start/end`; legacy `auto_compaction_start/end` remain
accepted. One structured ACP compaction record carries the native phase, start
time, duration and completed/failed/cancelled outcome. A verified native JSONL
entry ID correlates successful live and historical records; no rollout is edited.

Prompt admission occurs after Pi preflight compaction. The ordinary 30-second
RPC deadline probes `get_state` while native compaction is active instead of
ending the turn. A failed health check or a missing admission still fails with
its actual cause, after native abort confirms idle (or the owned native process tree has been terminated).
Manual `/compact` follows the same queue, cancellation and card lifecycle.
Provider retries that eventually succeed no longer inherit an earlier error.
No synthetic percentage, credentials or prompt text is added to diagnostics.

If native RPC abort fails, Windows terminates the owned launcher **and its descendants** with the system process-tree operation and awaits launcher exit; Unix uses the private process group created at spawn. Launcher exit alone is not a successful stop. If termination cannot be confirmed, the adapter returns structured `PI_STOP_UNCONFIRMED` so matching CodeG tears down the owned ACP connection before publishing failure. Provider failures with a confirmed stop retain the session for retry. No arbitrary caller-provided PID is accepted.
