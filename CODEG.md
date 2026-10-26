# CodeG distribution: 0.0.34-codeg.1

Based on svkozak/pi-acp (MIT), retaining upstream copyright and license.
Requires Node >=22.19.0 and Pi >=1.4.0. CodeG ships a private Node 24.16.0,
Pi 1.4.0 and this adapter as a versioned group; no global npm installation or
credential migration is required.

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
