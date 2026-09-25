# Codex first connection: PR/main integration readback t001

Date: 2026-09-25. This records remote publication after the distinct
[local validation](VALIDATION-CODEX-FIRST-RUN-T001.md); it is not another
Agent, model or host-native tool test.

- [PR #55](https://github.com/luomo66ccff/reflexmesh/pull/55) was published
  from Amahane-Hikari as head `3a7534030722f81de780946af8174d0931515162`,
  with parent main `41486ed4edbfaa3064c0fe48455ffd25c6febf5a`.
- The remote head tree was `08cd2fb7d00b7422657b4e63b6da0c9cf1c04510`,
  matching the reviewed local index tree. The PR file list contained only the
  13 intended first-run files; the remote main baseline differed from the
  local index in exactly those paths.
- All five configured checks completed successfully on the exact PR head:
  [PR workflow](https://github.com/luomo66ccff/reflexmesh/actions/runs/36083421516).
  Mergeability was clean before merge.
- The PR merged as `3fd1a72833ad9e616d319c6f7b35bcc2dd3576fd`; its parents
  were the prior main and the exact PR head. Its tree remained
  `08cd2fb7d00b7422657b4e63b6da0c9cf1c04510`, and main pointed to that
  merge commit on readback.
- All five configured checks also completed successfully on the exact main
  merge commit: [main workflow](https://github.com/luomo66ccff/reflexmesh/actions/runs/36083701886).

This confirms publication and configured CI, not current user profile
installation, real Codex Agent behavior, default-profile compatibility,
representative user value or bug-free scope.
