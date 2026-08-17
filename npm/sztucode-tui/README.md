# sztucode-tui

The npm package for the SztuCode TypeScript terminal coding agent. Despite the legacy package name, the current interface is the Node terminal chat client, not the Python Textual application.

## Install

Node.js 20 or newer is required. Python is not required for the agent runtime.

```sh
npm install --global sztucode-tui
sztucode /path/to/project
```

The package includes the compiled TypeScript daemon and CLI. It does not create a virtual environment.

Both command names are available:

```sh
sztucode /path/to/project
sztucode-tui /path/to/project
```

See the [SztuCode repository](https://github.com/rojim666/SztuCode) for configuration and usage.
