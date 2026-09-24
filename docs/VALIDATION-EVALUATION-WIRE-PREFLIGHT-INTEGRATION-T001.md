# Evaluation request-body preflight: integration readback t001

Date: 2026-09-25. This report records the remote GitHub integration of the
separate [local validation](VALIDATION-EVALUATION-WIRE-PREFLIGHT-T001.md).
It does not repeat local tests as independent model or host acceptance.

## Exact reviewed scope

- GitHub identity for the write: `Amahane-Hikari`.
- [PR #47](https://github.com/luomo66ccff/reflexmesh/pull/47) head:
  `7114d50ced6024a26a756422ee362a53b35f8d5b`; parent:
  `533024485c5064c48678d7572b4056a5677f1873`.
- Reviewed tree: `b9022af8f2834e8d5ae55d615c49c711a975cd4d`.
  Remote PR readback contained exactly the 15 intended source, test and
  documentation paths. No unrelated staged history was included.
- The five jobs on the [exact PR head](https://github.com/luomo66ccff/reflexmesh/actions/runs/36063851889)
  all concluded `success`: Ubuntu Node 22; Windows Node 22/24; and the
  affected-runtime negative checks on Ubuntu and Windows.
- PR #47 was merged as `a82fe88d572da0db9ebc786dd7295c87254361f0`.
  Its two parents are the former main and the reviewed PR head. Its tree is
  exactly the reviewed tree above; the main ref read back that merge commit.
- The same five jobs on the [exact main merge commit](https://github.com/luomo66ccff/reflexmesh/actions/runs/36064242809)
  all concluded `success`.

## Boundary

These results show the reviewed implementation reached main without a tree
change and passed the configured CI matrix. They do not establish real
DeepSeek or Jev model quality, account availability, provider billing, or
broad host lifecycle acceptance. The local process had no DeepSeek key,
model or provider revision configured, so this increment made no paid model
request. The long-term product objective remains open.
