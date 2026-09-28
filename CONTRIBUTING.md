# Contributing

## Prerequisites

- [Zelos CLI](https://docs.zeloscloud.io/cli)
- Node.js 20.x (see `.nvmrc`)
- [just](https://github.com/casey/just)

## Commands

| Command                | Description                                 |
| ---------------------- | ------------------------------------------- |
| `just install`         | Install dependencies (`npm ci`)             |
| `just dev`             | Start Vite development server               |
| `just test`            | Run tests                                   |
| `just test-watch`      | Run tests in watch mode                     |
| `just format`          | Format code with Prettier                   |
| `just format-check`    | Check formatting without writing            |
| `just lint`            | Lint with ESLint                            |
| `just tsc`             | Type-check                                  |
| `just check`           | Lint + type-check                           |
| `just build`           | Build `dist/`                               |
| `just package`         | Build and package for the Zelos marketplace |
| `just ci`              | Everything CI runs                          |
| `just release VERSION` | Bump version, check, build, commit, and tag |
| `just clean`           | Remove build artifacts                      |

## Development modes

### Standalone

```bash
just dev
```

Starts Vite with the SDK's `MockBridge`, and `src/mocks/modbus-mock.ts` installs a stateful Modbus
simulator on it: a power-meter register map with ticking measurements, persistent writes, and real
device memory so raw reads round-trip through the client codec.

Pick a capability state with `?mock=<scenario>`:

| Scenario             | What it simulates                                                       |
| -------------------- | ----------------------------------------------------------------------- |
| `ready` (default)    | One agent, two mapped units on a TCP connection + a raw-only RTU device |
| `extension-missing`  | Agent has no Modbus extension installed                                 |
| `extension-stopped`  | Installed but not running (Start button live)                           |
| `extension-outdated` | Pre-0.1.6 action set (`modbus/*`) — the required-methods gate trips     |
| `no-devices`         | Running, healthy actions, zero devices configured                       |
| `multi-agent`        | One ready agent + one missing the extension                             |

The SDK renders a Development Mode banner with theme toggles, applies the Zelos light/dark tokens
to the document, and toasts follow the resolved host theme.

For bridge troubleshooting, run with DevTools open and set:

```js
localStorage.setItem("ZELOS_BRIDGE_DEBUG", "1");
```

Then reload to enable `[zelos-bridge]` debug logs.

### Integrated (desktop app)

```bash
npm run build            # dist/ is gitignored, so build before installing
zelos extensions install-local .
```

The extension then appears in the app rail. For iterative work run `npx vite build --watch` in a
second terminal: the desktop app serves local installs from your source tree via `.dev_source`, so
rebuilt assets are picked up on reload without re-running `install-local`.

Embedded extensions run under the `zelos-app://` CSP, which does not allow arbitrary external
`http:`/`https:` requests. Everything this app needs goes through the bridge, so that only matters
if you add new network calls. The desktop shell also keeps a bounded set of app iframes mounted, so
don't assume one long-lived React mount across tab switches.

## Architecture

| Layer                    | File                                                         |
| ------------------------ | ------------------------------------------------------------ |
| Wire contract            | `src/lib/types.ts` (hand-maintained, snake_case)             |
| Action wrappers          | `src/lib/modbus-bridge.ts`                                   |
| Capability resolver      | `src/lib/capability.ts` (pure)                               |
| Value codec              | `src/lib/codec.ts` (pure, ports the extension's Python)      |
| Raw rows + request plans | `src/lib/raw-store.ts` (pure + localStorage)                 |
| Server state             | `src/hooks/*` — TanStack Query, 1 Hz snapshot, 5 s discovery |

All server state goes through TanStack Query. The snapshot key is
`["modbus-snapshot", agent, device]`, so every subscriber on one device shares a single poll.

## Testing

Vitest + React Testing Library. The pure layers carry the coverage — `codec.test.ts` is transcribed
from the extension's own `tests/test_modbus.py` vectors so the two implementations can't drift.

```bash
just test        # run once
just test-watch  # watch mode
```

## Release

```bash
just release 1.0.0
```

Bumps `extension.toml` + `package.json`, formats, checks, builds, commits, and tags. Push with
`git push --follow-tags`; the Release workflow builds the `.tar.gz` and attaches it to the GitHub
release, which is what gets uploaded to the marketplace.

## Layout constraints

- `vite.config.ts` uses `base: "./"` so assets resolve from `zelos-app://.../{entry}`
- `extension.toml` points at `dist/index.html`; `dist/` is built, not committed
- Avoid root-absolute asset paths like `/assets/...`
