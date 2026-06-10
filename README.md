# homebridge-esphome-ts

[![npm-version](https://badgen.net/npm/v/homebridge-esphome-ts)](https://www.npmjs.com/package/homebridge-esphome-ts)
[![CI](https://github.com/lucavb/homebridge-esphome-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/lucavb/homebridge-esphome-ts/actions/workflows/ci.yml)

[Homebridge](https://homebridge.io) plugin for [ESPHome](https://esphome.io/), connecting ESP devices directly to HomeKit via the native ESPHome API — no Home Assistant required.

## Supported components

- Lights (including RGB and brightness)
- Switches
- Binary sensors (motion, window, door, smoke, leakage)
- Sensors (temperature and humidity)

## Requirements

- Node.js **22** or **24**
- Homebridge **1.6+** or **2.x**

## Installation

> **Beta (testing):** Homebridge 2 / Node 22+ pre-release — not confirmed with real hardware yet.
> Install with: `npm install -g homebridge-esphome-ts@beta`
> Please [open an issue](https://github.com/lucavb/homebridge-esphome-ts/issues) with feedback.

Install through [Homebridge Config UI X](https://github.com/oznu/homebridge-config-ui-x) or manually:

1. Install [Homebridge](https://github.com/homebridge/homebridge/wiki).
2. Run `npm install -g homebridge-esphome-ts` (or `@beta` for the current pre-release).
3. Add the platform to your `config.json`:

```json
"platforms": [
    {
        "platform": "esphome",
        "devices": [
            {
                "host": "my-esp.local",
                "password": "",
                "port": 6053
            }
        ],
        "discover": true
    }
]
```

Make sure your ESPHome configuration includes an `api:` section. See [`examples/esphome_configuration.yaml`](examples/esphome_configuration.yaml) for a starting point.

## Configuration

All options are optional unless noted.

| Option                 | Type     | Default        | Description                                                      |
| ---------------------- | -------- | -------------- | ---------------------------------------------------------------- |
| `devices`              | array    | `[]`           | ESPHome devices to connect to. Each entry needs at least `host`. |
| `devices[].host`       | string   | —              | Hostname or IP address (**required** per device).                |
| `devices[].port`       | number   | `6053`         | Native API port.                                                 |
| `devices[].password`   | string   | `""`           | API password from your ESPHome config.                           |
| `devices[].retryAfter` | number   | platform value | Reconnect delay for this device (ms).                            |
| `discover`             | boolean  | `false`        | Discover password-less devices via mDNS.                         |
| `discoveryTimeout`     | number   | `5000`         | mDNS discovery timeout (ms).                                     |
| `retryAfter`           | number   | `90000`        | Default reconnect delay (ms).                                    |
| `blacklist`            | string[] | `[]`           | Component names to exclude from HomeKit.                         |
| `debug`                | boolean  | `false`        | Log raw API traffic to console and `/tmp`.                       |

When `discover` is enabled and you have no password-protected devices, you can omit the `devices` array entirely.

Per-device `retryAfter` overrides the platform-level value when set.

### Blacklist example

```json
{
    "platform": "esphome",
    "devices": [{ "host": "my-esp.local" }],
    "blacklist": ["My blacklisted switch"]
}
```

## Troubleshooting

Add `"debug": true` to your platform config and attach the console output (and `/tmp/esphome-log-*.json` files if present) when opening a GitHub issue. Remove sensitive data from your config before sharing.

## Development

```bash
npm ci
npm run cq      # typecheck, lint, format check, build
npm run test    # unit tests
npm run integration:test  # manual smoke test with examples/
```

Releases are automated via [semantic-release](https://semantic-release.gitbook.io/) on pushes to `main`.

## License

GPL-3.0
