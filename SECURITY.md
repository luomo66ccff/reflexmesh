# Security / 安全边界

ReflexMesh v0.1 is an experimental library. It has not undergone an external security audit and is not suitable as the sole control for production or high-impact actions.

- Keep Jev keys server-side. `.env` is ignored; no secrets are included in this scaffold. Do not upload real keys into issue reports or chats.
- Authenticate at the host boundary. Tenant IDs and principal IDs in examples are fixtures, not verified identities.
- Explicitly authorize external provider data transfer and minimize/redact state before invoking the library. Automatic secret redaction of arbitrary prose is **not** implemented.
- Tool metadata is trusted registration. A model cannot create capabilities, grant permissions or mark a tool safe. Read-only does not mean non-sensitive.
- All writes are blocked in v0.1. The future approval/Saga system is not yet available.
- Low confidence, malformed output, unsupported labels and provider failures fail closed. No silent fallback to a fabricated successful model result.
- Runtime timeout only bounds waiting; it cannot guarantee that an underlying tool stopped. Treat `recovery_required` as unknown outcome, not clean failure.
- In-memory idempotency does not survive restart and is not shared across processes. Do not deploy multiple write-capable workers relying on it.
- JSONL is a local single-process sink, not a distributed or tamper-proof log. Existing file permissions are not retroactively tightened; use a protected directory.
- Fingerprints are not anonymization. Audit metadata and even choice labels can reveal context. Apply access controls and retention limits.
- Current decision thresholds are demonstration values without real-data calibration. Do not use high model confidence as a substitute for permission or independent evidence.

For a security report, avoid publishing sensitive exploit data or credentials in a public issue. Use the repository owner's private reporting channel once the actual repository is established.

## v0.2 optional durable/shadow layer

The v0.1 cautions above still apply to the original in-memory runtime. The optional `DurableMesh` + `SqliteKernel` wrapper persists admission/metadata and conservatively retains unknown execution states. It does not add write permissions, raw-output caching, encryption, external exactly-once effects or automatic recovery. The three harness-facing adapters are shadow/advisory only and do not replace host authorization. See `docs/DURABLE-SHADOW.md#limits` before connecting real data or tools.
