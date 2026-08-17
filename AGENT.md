# AGENT.md

> Current product path: TypeScript. The daemon, Agent Loop, protocol, CLI, desktop IPC, and evaluation runner live under `packages/` and `desktop/`.

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

The Tauri desktop workbench and Node terminal client connect to the persistent TypeScript daemon over JSON-RPC 2.0 NDJSON.

```
packages/runtime-ts (daemon)
  └─ 127.0.0.1:7438
       ↑ JSON-RPC 2.0 NDJSON
packages/cli   desktop (Tauri + Vue)
```

Shared request, response, event, and workflow types live in `packages/protocol`. Runtime behavior belongs in `packages/runtime-ts`; do not add product contracts to external scripts or generated files. The desktop application is the primary user-facing surface and must be built after UI changes.

## TypeScript conventions

- Keep public RPC parameters and results typed in `packages/protocol`.
- Prefer discriminated unions for protocol state and event handling.
- Keep filesystem and workspace boundaries in runtime helpers; never accept an unchecked path from an RPC request.
- Add focused tests for permission, session, persistence, provider, and error-path changes.
- Use Node built-ins and existing workspace dependencies before adding a package.
- Comments should explain non-obvious constraints, not restate code.

## Python boundary

Python is not a product runtime or development dependency. A small number of Skill directories under `packages/runtime-ts/skills` contain Python scripts because their document, image, spreadsheet, and presentation libraries are Python-first. Those scripts are isolated subprocess tools and must not define daemon, CLI, protocol, or desktop behavior.

## Documentation

Current user, contributor, architecture, testing, and operations documentation lives in `docs/`; historical proposals are under `docs/archive/` and do not define current behavior. Protocol documentation is generated with `npm run docs:protocol`.
