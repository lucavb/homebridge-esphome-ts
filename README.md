# homebridge-esphome-ts

This plugin integrates the [esphome](https://esphome.io/) platform into homebridge so that you don't have to go
through homeassistant if you don't want to (not that here is anything wrong with that). It makes use of the native API of esphome
so that you can expect instant updates for all your binary sensors what have you.

Supported components include:

* Lights
* Switches
* BinarySensors (motion, window, door, smoke and moisture(leak))
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

## Todo

- [ ] Implement a blacklist for components
- [ ] Testing, especially the hap-nodejs >= 0.5 requirement
- [x] Implement sensor component

## Troubleshooting

Please make sure to add the `api` entry to your config!

If you find anything else, feel free to open an issue on GitHub :)
