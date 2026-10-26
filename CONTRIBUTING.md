# Contributing

## Prerequisites

- [Zelos](https://zeloscloud.io) 26.0.10 or later
- [Zelos CLI](https://docs.zeloscloud.io/reference/cli/) 0.1.11 or later
- [just](https://github.com/casey/just)
- Node.js 24 LTS (see `web/.nvmrc`)

## Layout

`extension.toml` describes everything the extension contributes:

| Part | Files | Manifest |
| ---- | ----- | -------- |
| Tab | `web/src/tab/` | `[app] tab` |

The web project builds the tab document into `dist/` at the project root with `just build`
(`npm run build`). `.gitignore` keeps `dist/` out of the repository, so a fresh clone has none
until its first build.

| Layer                    | File                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| Wire contract            | `web/src/lib/types.ts` (hand-maintained, snake_case)             |
| Action wrappers          | `web/src/lib/modbus-bridge.ts`                                   |
| Capability resolver      | `web/src/lib/capability.ts` (pure)                               |
| Value codec              | `web/src/lib/codec.ts` (pure, ports the extension's Python)      |
| Raw rows + request plans | `web/src/lib/watch-store.ts` (pure + localStorage)               |
| Server state             | `web/src/hooks/*` — TanStack Query, 1 Hz snapshot, 5 s discovery |
| Mock host                | `web/src/mocks/modbus-mock.ts`                                   |

All server state goes through TanStack Query. The snapshot key is
`["modbus-snapshot", agent, interface]`, so every subscriber on one interface shares a single poll.

## Commands

| Command                | Description                                        |
| ---------------------- | -------------------------------------------------- |
| `just install`         | Install dependencies                               |
| `just format`          | Format code with Prettier                          |
| `just check`           | Check formatting, lint (ESLint), type-check        |
| `just test`            | Run tests (Vitest)                                 |
| `just build`           | Build the web project into `dist/`                 |
| `just package`         | Build and package for the Zelos marketplace        |
| `just release VERSION` | Bump version, check, test, build, commit, tag      |
| `just clean`           | Remove build output, caches and packages           |

`just --list` also shows the recipes each part adds. With a web project only, install
[pre-commit](https://pre-commit.com) yourself and run `pre-commit install`.

## Run it in Zelos

```bash
just build
zelos extensions install-local .
```

A local install runs from your project directory, so you do not install again after a code
change:

- Tab: after a rebuild, reload the tab. Keep `just watch` running to rebuild on every save, and
  use `just dev` to work on it in the browser against the mock host of the SDK.
- `extension.toml`: run `zelos extensions install-local .` again.

The tab needs the Modbus agent extension running on an agent, with at least one interface
configured.

## Mock host

`just dev` runs the tab against `web/src/mocks/modbus-mock.ts`, a stateful Modbus simulator on
the SDK's mock host: a power-meter register map with ticking measurements, persistent writes,
and real device memory, so raw reads round-trip through the client codec.

Pick a capability state with `?mock=<scenario>`:

| Scenario             | What it simulates                                            |
| -------------------- | ------------------------------------------------------------ |
| `ready` (default)    | One agent, a mapped TCP interface + a raw-only RTU interface |
| `extension-missing`  | Agent has no Modbus extension installed                      |
| `extension-stopped`  | Installed but not running (Start button live)                |
| `extension-outdated` | 0.1.4-era action set, so the required-actions check trips    |
| `no-interfaces`      | Running, healthy actions, zero interfaces configured         |
| `multi-agent`        | One ready agent + one missing the extension                  |

## Testing

Vitest and React Testing Library. The pure layers carry the coverage: `codec.test.ts` takes its
vectors from the extension's own `tests/test_modbus.py`, so the two implementations agree.

## Packaging

```bash
just package
```

The archive lands next to `extension.toml` as `<name>-<version>.tar.gz`, where `<name>` is the
manifest name in lowercase with every other run of characters turned into one hyphen. It holds
`extension.toml`, the README, the icon and the paths listed in `[package] paths`: `dist/`.

## Release

```bash
just release 1.0.0
git push --follow-tags
```

The release workflow checks, tests, builds and packages the extension, then attaches the
archive to a GitHub release.
