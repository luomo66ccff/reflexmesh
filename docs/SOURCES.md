# Verified external contracts

Checked on 2026-09-18. These are interface references, not proof of model quality or live access.

## TypeSafe official SDK

- Repository: https://github.com/typesafe-ai/typesafe-sdk-js
- `src/types.ts`, blob `cd0a72d5a2c0492ea309f6aebf8c92f13892b2dc`: question/result types, Noul probability, Choice distributions, expected Score, snake_case token usage on the wire.
- `src/client.ts`, blob `5846677aaaf2d2578d3c79f09a90f06d8e28a085`: API root `https://api.typesafe.ai`, `POST /v1/systemone`, Bearer authorization and `{state, questions, model}` request shape.
- README, blob `7e834076c14e955e7fa943a1405c1c304fabfe56`: official JS SDK usage.

The prototype implements its own small HTTP adapter against these contracts, rather than installing the SDK. It intentionally narrows question instruction/criterion descriptions to strings, has no automatic retries or model alias default, and limits request/response sizes. Official metadata `legend` is not needed by the normalized runtime Score result.

The documentation website was not reachable in the preparation environment; source files were read through the connected GitHub tools. Live API inference was not attempted without a key.

## GitHub publication

- GitHub CLI repository creation: https://cli.github.com/manual/gh_repo_create
- Authentication: https://cli.github.com/manual/

`gh repo create OWNER/NAME --private --source . --remote origin --push` is the documented path used by the publication helper. It requires an authenticated GitHub CLI on the user's machine. The assistant's connected GitHub reader/writer does not imply that GitHub CLI or a separate browser is logged in.

## Build and CI

- TypeScript 5.8.3 metadata and integrity: https://registry.npmjs.org/typescript/5.8.3
- `actions/checkout` v5 tag resolved to `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09`.
- `actions/setup-node` v5 tag resolved to `a0853c24544627f65ddf259abe73b1d18a591444`.

Action refs were checked via GitHub's Git refs API and pinned by commit in CI. This is not a claim that v5 is the latest action version. Remote CI has not yet been run for this project.
