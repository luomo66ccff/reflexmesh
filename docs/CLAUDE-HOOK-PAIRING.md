# Claude hooks: durable pairing without claiming execution authority

Both `claude-hook.mjs` and `claude-task-hook.mjs` now use the same local,
cross-process pairing protocol. Choose **one entrypoint per event**; do not
install both, duplicate a matching hook, or run old and new hook versions
together. Their stdout remains `{}` and their observation errors remain fixed
stderr diagnostics. They never approve, deny, retry or replace a host tool.

This closes a specific evidence gap: a rejected or ambiguous pre-observation
must not let a later post-observation attach a new invocation's outcome to an
older same-ID decision. It does not authenticate the host or make tools
exactly-once. See [reproductions and validation](VALIDATION-CLAUDE-PAIRING.md).

## What is persisted

Schema 3 adds `claude_hook_pairs` in the **execution ledger**, not the optional
task cache. A first pre-hook reserves a random receipt before task-cache
open/read, intent resolution or semantic evaluation. Its namespace includes
tenant, scope, harness, session, agent and tool-use ID. Digests bind the normalized
call, exact action, pack and effective provider/host/task-policy deployment.

| Pair state | Meaning |
| --- | --- |
| `pending` | Reservation exists but its before-observation has not completed successfully. A post cannot finish it. |
| `ready` | The before-observation resolved and the receipt matches its stored run/request. A matching post may append a harness report. This is not execution permission or independently verified success. |
| `blocked` | An observed duplicate, conflict, failure or out-of-order event made pairing unavailable. It cannot be reset by another pre, post or late completion. |
| `not_recorded` in the evidence view | No pairing row was recorded, including historical schemas and other adapters. It does not certify a legacy Claude outcome. |

Completion compares the receipt token, descriptor and decision key and saves
the run request digest. Post-processing checks those stored bindings and inserts
the outcome within the same SQLite transaction. A rejected, valid event commits
its block before returning an error. Existing blocked rows retain their first
reason. Failed storage transactions cannot claim that a block was persisted.

The post hook deliberately does **not** read the current task summary. A normal
old tool result can arrive after a new prompt or a `Stop` cache clear and still
belong to its original task. Changing the deployment between pre and post,
however, is a conflict; restoring the configuration does not clear that block.

## Duplicate deliveries are a deliberate tradeoff

Any second pre for the same key blocks pairing, **even when every field is
identical**. An identical retransmission cannot be distinguished from another
invocation reusing that ID. The observer drops ambiguous evidence; it does not
stop the host's action. Do not retry the host action to repair the ledger.

Identical repeated posts deduplicate. A changed terminal report blocks pairing
and retains the original observation unchanged. A duplicate pre arriving after
a recorded success likewise retains that historical report but marks its
association ambiguous. [Evidence list/inspect](EVIDENCE.md) shows the pair state;
inspect explains the uncertainty. Doctor warns for a selected pending/blocked
decision record. Pair-only reservations without a decision row are not listed
by the decision evidence CLI; an empty list is not proof of no hook activity.

Ordinary library `before`/`after`, in-process DeepSeek/function-call admission,
MCP report provenance, execution tombstones and label rules are unchanged.
Pairing `blocked` is **not** execution `unknown` and grants no recovery/retry
permission. Direct database or library access remains trusted access.

## Trust and unobservable failures

The reviewed [official hook contract](https://code.claude.com/docs/en/hooks)
provides tool-use identity on pre/post events. This implementation does not have
a custom per-attempt nonce echoed by the host. It relies on trusted, unique
invocation IDs and observable ordered hook delivery; that is an engineering
assumption, not host-authentication proof. A current prompt identifier is not a
replacement for an invocation nonce and must not reject legitimate late results.

For a repeatable account-free check, the [installed-host local loop](CLAUDE-LOCAL-LOOP.md)
uses real Claude 2.1.263 hook processes and native Read with synthetic localhost
Messages. Its duplicate-delivery injection verifies ambiguity rejection without
stopping the native action. It does not close default-profile, cancellation,
subagent, parallel-tool or restart acceptance gates.

Malformed/oversized JSON, invalid configuration, unavailable storage, a hook
that never starts, or process death **before durable reservation** may leave no
new marker. An unseen reused invocation cannot be detected from a later matching
post alone. Invalid descriptor/outcome envelopes are rejected before mutation.
If the process dies while its reservation is still pending, that row remains
non-ready; a later post blocks it instead of guessing. Same-user database
tampering is outside this boundary.

## Upgrade and rollback

1. Stop all old hook/library workers using the ledger and quiesce outstanding
   work. An already-open old connection cannot be made safe by a new version's
   startup check.
2. Make a SQLite-consistent backup, including the committed WAL state. Do not
   copy only an active main database file.
3. Install one consistent hook version and build it. A writable open atomically
   upgrades schema 1 or 2 to 3. Read-only evidence/recovery/doctor opens support
   schemas 1, 2 and 3 without migration.
4. Existing runs, observations, reviews and labels stay unchanged. No historical
   pairing is invented: reusing an unpaired old key is blocked. Existing old
   software rejects schema 3 on a fresh open; there is no in-place downgrade.

Never reset `PRAGMA user_version`, delete pair rows or discard idempotency
tombstones to bypass a conflict. Restoring an older backup can lose later
actions; independently reconcile outstanding work before restoring software/data.
See the [recovery runbook](RECOVERY.md). Automatic retention and production
migration/load certification remain outside this alpha.
