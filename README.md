# homebridge-esphome-ts

This plugin integrates the [esphome](https://esphome.io/) platform into homebridge so that you don't have to go
through homeassistant if you don't want to (not that there is anything wrong with that). It makes use of the native API of esphome
so that you can expect instant updates for all your binary sensors what have you.

Supported components include:

- Lights
- Switches
- BinarySensors (motion, window, door, smoke and leakage)
- Sensors (temperature & humidity at the moment)
- LightSensors (illuminance)

This project is currently still in beta, but I thought that many eyes see more than just
my two :)

Every exposed accessory carries a `StatusActive` characteristic: it is true while the connection
to the esphome device is up and false while it is down, in which case HomeKit flags the values
as stale. Accessories restored from Homebridge's cache regain status sync once the device
reconnects.

## Requirements

- Node.js >= 22.12
- Homebridge ^1.6.0 or ^2.0.0

## Installation

Unless you haven't done so already, make sure to install homebridge first. See instructions
[here](https://github.com/homebridge/homebridge/wiki). Once you have done this, you can install this plugin by typing

```
npm i -g homebridge-esphome-ts
```

Once this is done, you can configure your homebridge config.json according to the next section.

## Getting Started

```json
{
    "platform": "esphome",
    "devices": [
        {
            "host": "my_esp.local",
            "password": "Passw0rd!",
            "port": 9001,
            "retryAfter": 120000 // optional, time in milliseconds!
        }
    ],
    "retryAfter": 60000 // optional, time in milliseconds!
}
```

Only the `host` key is mandatory under devices. As password `''` is assumed aka no password and the default
port number 6053 is also wired into the plugin. `encryptionKey` and `password` are optional; see
[API encryption](#api-encryption). You can add, in theory, as many ESP devices as you want to
that array.

If some of your devices are password-less you can enable devices discovery to let the plugin find all your
devices by setting `discover: true` in platform configuration. In case if you don't have any password-secured
devices you can even fully omit `"devices"` section in platform configuration.

In case you don't have a working esphome configuration you can have look at the examples folder. There you will
find both an example homebridge `config.json` file as well as an example esphome configuration. For further guidance
on esphome please check out their website.

### retryAfter

Both `retryAfter` keys are as explained optional and need to contain an integer that tells this plugin
after what time frame it should try to reconnect. Keep in mind that this value needs to be in _milliseconds_. The inner
`retryAfter` will trump the outer value if present. The default value is 90 seconds.

A device that rejects the configured password or encryption key, requires a key that is not configured,
or is plaintext while a key is configured stops retrying entirely: esphome-ts latches those failures
as terminal because the configuration cannot change while the device is running. Fix the device entry
in your config and restart homebridge to reconnect.

### API encryption

Current ESPHome firmware uses the native API's Noise encryption instead of the old `api: password:`
option. Copy the key exactly as ESPHome prints it:

```yaml
api:
    encryption:
        key: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA='
```

The key above is a throwaway example; use the value ESPHome prints for your device. Put it on the
device entry:

```json
{
    "platform": "esphome",
    "devices": [
        {
            "host": "my_esp.local",
            "encryptionKey": "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA="
        }
    ]
}
```

The key must decode to 32 bytes. ESPHome reserves the all-zero key as its provisioning sentinel; it
provides no protection and is rejected. `password` remains supported for older firmware, but ESPHome
2026.1 removed it. A device uses one authentication mechanism, not both. The key is stored as plain
text in `config.json`, so keep that file private.

If a device rejects the key, check it after a key rotation or when the device is re-provisioned
(reflashing alone does not change the key): the old key produces a terminal authentication failure
until you update `config.json`.

mDNS discovery still finds encrypted devices, but it cannot supply the key. List encrypted devices
under `devices` with their `encryptionKey`; discovery will then reuse that entry when the host matches.
`host` must be the mDNS hostname that discovery reports (for example `my_esp.local`), not an IP
address: an IP-keyed entry is discovered as a second, keyless device and fails with an encryption
error.

### Blacklisting

If for some reason you want to exclude a specific component from this plugin just
add a key containing its name (as it was defined in esphome and is shown initially in HomeKit) to a string array under the key `blacklist`:

```json
{
    "platform": "esphome",
    "devices": [
        ...
    ],
    "blacklist": [
        "My blacklisted switch"
    ]
}
```

## Todo

- [x] Implement a blacklist for components
- [x] Testing, especially with the new homebridge version
- [x] Implement sensor component

## Troubleshooting

Please make sure to add the `api` entry to your config!

If you still have problems please feel free to open a ticket on GitHub. Before doing so add this to your
config `"debug": true`. The plugin will now output what it has gotten from your ESP device.
Please append this when you open a ticket here on GitHub. Please attach your config as well and make
sure to remove any sensitive information such as WiFi passwords, the API `encryptionKey`, and the
legacy `password`.

In addition to simply writing stuff to the console, it will also write everything received from your devices to individual
files under `/tmp`. You can then submit these files with any issues you might file on GitHub.

_Slight warning_ The writing of these files means that it will also occupy more space on your SD card or whatever you
might have. So simply turn off this option once you don't need it anymore.

These files contain the device's inbound traffic, decrypted when API encryption is enabled. Treat them
as sensitive: they do not contain the encryption key, but they do contain device state and the messages
the device sends (not the commands Homebridge sends).
