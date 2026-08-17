# TypeScript Runtime Migration

The repository's default product path uses the TypeScript runtime. Python is
retained only for legacy clients and specialized artifact scripts:

- `protocol/` is the shared JSON-RPC, event and workflow contract.
- `runtime-ts/` is a Node.js daemon with TCP/NDJSON transport, an event bus,
  run lifecycle, workflow helpers, workspace boundary checks and a typed tool
  registry.

Run the current TypeScript checks from the repository root:

```powershell
npx tsc -p packages/protocol/tsconfig.json --noEmit
npx tsc -p packages/runtime-ts/tsconfig.json --noEmit
npx tsc -p desktop/tsconfig.json --noEmit
npx tsx --test packages/runtime-ts/tests/runtime.test.ts
```

Start the TypeScript daemon on port `7438`:

```powershell
npm run --prefix packages/runtime-ts dev
```

The runtime keeps the same JSON-RPC envelope as the legacy daemon. It supports
OpenAI-compatible and Anthropic providers, context budgeting, session history,
workspace tools, permissions, Git operations, skills, MCP clients, subagents,
and typed workflow orchestration. The Tauri desktop and Node terminal client
are the supported product surfaces. Python remains only for legacy validation,
SWE-bench fixtures, and specialized artifact scripts.
