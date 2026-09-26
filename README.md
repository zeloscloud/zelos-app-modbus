# Modbus Control

Read and write Modbus registers from the Zelos desktop app — pairs with the
[`zeloscloud.zelos-extension-modbus`](https://github.com/zeloscloud/zelos-extension-modbus)
agent extension (0.2.0+).

- 🛰️ One card per agent, devices grouped by connection (TCP / RTU) with live connection + poll counters
- 📇 One table per device: registers from the map and raw addresses, side by side, saved between sessions
- 🔄 On-demand **Read** per row — the only way to see `rate: 0` registers
- ✏️ Inline **Write**, range-checked before it hits the wire; coils as a switch; the typed value sticks, so duplicate rows act as presets
- 🔔 Failures toast with a humanized message and copy-details JSON; successes just show the new value

## The table

| Column  | Notes                                                                  |
| ------- | ---------------------------------------------------------------------- |
| Address | Decimal + hex, e.g. `100 (0x0064)`                                     |
| Table   | `holding` / `input` / `coil` / `discrete` — inputs are read-only       |
| Type    | Datatype, plus byte order and scale when they aren't the defaults      |
| Value   | Named rows from the 1 Hz snapshot, dimmed past ~3× the poll rate       |
| Write   | Value + **Write**, a switch for bits, `—` where the table is read-only |

**Add** picks a register out of the map, or starts a **raw row** — any address, with its table,
datatype and byte order edited inline in the row and committed as you go. Raw rows have no poll
behind them: they read on demand (`read_register`, decoded client-side) and write FC6 / FC16 / FC5
by width and table.

Values are decoded and encoded by `src/lib/codec.ts`, a 1:1 port of the extension's
`decode_value` / `encode_value`, so a raw read of a mapped address agrees with that register's named read.

## Development

`just dev` runs standalone against a stateful mock host. Add `?mock=<scenario>` to exercise a
capability state: `ready` (default), `extension-missing`, `extension-stopped`,
`extension-outdated`, `no-devices`, `multi-agent`. See [CONTRIBUTING.md](CONTRIBUTING.md).
