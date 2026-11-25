import type { API, PlatformAccessory } from 'homebridge';

/**
 * Sets `StatusActive` on every service of the given accessories, adding the characteristic
 * where it is not present yet (skipping AccessoryInformation services, where StatusActive is
 * semantically inert). `active: false` signals HomeKit that the exposed values are stale
 * because the Device connection was lost.
 *
 * The Device session owns the `alive$` watch and its log lines; the platform applies the
 * emitted state here on every change.
 *
 * Write policy:
 * - New characteristic: added via `addCharacteristic`, then initialised with `setValue` —
 *   the sanctioned immediate-init idiom right after adding.
 * - Pre-existing characteristic: silent push via `updateValue`, which never re-enters an
 *   `onSet` handler on the characteristic.
 */
export const applyConnectionStatus = (accessories: PlatformAccessory[], active: boolean, api: API): void => {
    const { Characteristic: CharacteristicClass, Service: ServiceClass } = api.hap;
    for (const accessory of accessories) {
        for (const service of accessory.services) {
            if (service.UUID === ServiceClass.AccessoryInformation.UUID) {
                // StatusActive has no meaning on AccessoryInformation and would pollute the accessory JSON.
                continue;
            }
            if (!service.testCharacteristic(CharacteristicClass.StatusActive)) {
                service.addCharacteristic(new CharacteristicClass.StatusActive());
                // Immediate init right after addCharacteristic (the sanctioned setValue idiom).
                service.getCharacteristic(CharacteristicClass.StatusActive).setValue(active);
            } else {
                // Pre-existing characteristic: silent push — updateValue never re-enters an onSet handler.
                service.getCharacteristic(CharacteristicClass.StatusActive).updateValue(active);
            }
        }
    }
};
