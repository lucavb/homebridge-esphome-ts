# homebridge-esphome-ts

This plugin integrates the [esphome](https://esphome.io/) platform into homebridge so that you don't have to go
through homeassistant if you don't want to (not that here is anything wrong with that). It makes use of the native API of esphome
so that you can expect instant updates for all your binary sensors what have you.

Supported components include:

* Lights
* Switches
* BinarySensors (motion, window, door, smoke and leakage)
* Sensors (temperature & humidity at the moment)

This project is currently still in beta, but I thought that many eyes see more than just
my two :)

## Getting Started

```json
{
    "platform": "esphome",
    "devices": [
        {
            "host": "my_esp.local",
            "password": "Passw0rd!",
            "port": 9001
        }
    ]
}
```

Only the `host` key is mandatory under devices. As password `''` is assumed aka no password and the default
port number 6053 is also wired into the plugin. You can add, in theory, as many ESP devices as you want to
that array.

## Blacklisting

If for some reason you want to exclude a specific component from this plugin just
add a key to a string array under the key `blacklist`.

## Todo

- [x] Implement a blacklist for components
- [ ] Testing, especially with the new homebridge version
- [x] Implement sensor component

## Troubleshooting

Please make sure to add the `api` entry to your config!

If you still have problems please feel free to open a ticket on GitHub. Before doing so add this to your
config `"debug": true`. The plugin will now output what it has gotten from your ESP device.
Please append this when you open a ticket here on GitHub. Please attach your config as well and make
sure to remove any sensitive information such as WiFi passwords.
