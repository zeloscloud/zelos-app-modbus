# Modbus Control

Read and write Modbus registers from the Zelos desktop app — pairs with the
[`zeloscloud.zelos-extension-modbus`](https://github.com/zeloscloud/zelos-extension-modbus)
agent extension (0.1.5+).

- 🛰️ One card per agent, one section per interface (TCP / RTU) with live connection + poll counters
- 📇 Named registers grouped by event: address (dec + hex), table, datatype, unit, live value
- 🔄 On-demand **Read** per register — the only way to see `poll_interval: 0` registers
- ✏️ Inline **Write** on writable rows, range-checked before it hits the wire; coils as a switch
- 🧮 **Raw access** rows at any address, typed client-side and saved between sessions
- 🔔 Failures toast with a humanized message and copy-details JSON

## Named registers

| Column  | Notes                                                             |
| ------- | ----------------------------------------------------------------- |
| Address | Decimal + hex, e.g. `100 (0x0064)`                                |
| Table   | `holding` / `input` / `coil` / `discrete` — inputs are read-only  |
| Type    | Datatype, plus word order and scale when they aren't the defaults |
| Value   | From the 1 Hz snapshot, dimmed when older than ~3× the poll rate  |

## Raw access

| Row       | Fields                                                     | Wire                                 |
| --------- | ---------------------------------------------------------- | ------------------------------------ |
| **Read**  | address, table, datatype, word order, scale, count         | `read_register`, decoded client-side |
| **Write** | address, register/coil, datatype, word order, scale, value | FC6 / FC16 / FC5 by width and target |

Values are decoded and encoded by `src/lib/codec.ts`, a 1:1 port of the extension's
`decode_value` / `encode_value` (including its scaled-integer truncation), so a raw read of a
mapped address agrees with that register's named read.

## Development

`just dev` runs standalone against a stateful mock host. Add `?mock=<scenario>` to exercise a
capability state: `ready` (default), `extension-missing`, `extension-stopped`,
`extension-outdated`, `no-interfaces`, `multi-agent`. See [CONTRIBUTING.md](CONTRIBUTING.md).
