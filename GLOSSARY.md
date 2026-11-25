# homebridge-esphome-ts

Homebridge plugin that bridges ESPHome devices into HomeKit over the ESPHome native API.

## Language

**Device**:
A single ESPHome node reachable at a host and port, owning a set of components.
_Avoid_: ESP, node, board

**Device session**:
The lifecycle of one Device: construction, the reconnect cadence, the error policy, the debug dump,
Connection status, and the Discovery wait.
_Avoid_: connection, runtime

**Component**:
One addressable capability of a device: light, switch, binary sensor, sensor, cover, or fan.
_Avoid_: entity, channel

**Accessory**:
The HomeKit platform accessory built from one component.
_Avoid_: device (for the HomeKit side), gadget

**Component binding**:
The mapping that attaches a component onto an accessory: which service, which characteristics, how state is read, applied, and pushed.
_Avoid_: helper, mapper, wiring

**Connection status**:
Whether a device's transport is alive, surfaced as StatusActive on its accessories' services.
_Avoid_: reachability, online state

**Discovery**:
mDNS browsing for esphomelib services to find devices without configuration.
_Avoid_: bonjour (that is the mechanism, not the concept), scanning

**Blacklist**:
Component names excluded from accessory creation by configuration.
_Avoid_: ignore list

**Fan preset mode**:
A named fan program advertised by ESPHome (for example "sleep" or "auto"). HomeKit has no preset
characteristic, so each preset is bridged as its own Switch service.
_Avoid_: fan mode (ambiguous with HomeKit's TargetFanState), speed

**Encryption key**:
The base64-encoded 32-byte Noise PSK from ESPHome's `api: encryption: key:`, configured per device.
_Avoid_: password (the legacy, separate mechanism), PSK alone
