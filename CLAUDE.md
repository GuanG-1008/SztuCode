# CLAUDE.md

The current product is TypeScript. The daemon, Agent Loop, protocol, CLI, evaluation runner, and desktop IPC live under `packages/` and `desktop/`.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run build --prefix desktop
npm run docs:protocol
npm run docs:links
npm run daemon
npm run cli -- ping
```

## Architecture

The Tauri + Vue desktop workbench and Node terminal client connect to the persistent TypeScript daemon over JSON-RPC 2.0 NDJSON. Shared contracts live in `packages/protocol`; daemon behavior lives in `packages/runtime-ts`.

Keep new product behavior in TypeScript. Python scripts under `packages/runtime-ts/skills` are isolated helpers for artifact formats whose mature libraries are Python-first; they are not a supported runtime or client API.
