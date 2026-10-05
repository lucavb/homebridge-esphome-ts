import type { API, Logging, PlatformAccessory } from 'homebridge';
import { distinctUntilChanged, Subscription } from 'rxjs';
import type { Observable } from 'rxjs';

/** Structural stand-in for the part of EspDevice this unit needs. */
interface AliveStreamSource {
    alive$: Observable<boolean>;
}

export interface ConnectionWatchOptions {
    /** Accessories belonging to this device, evaluated at the time of each state change. */
    accessoriesOfDevice: () => PlatformAccessory[];
    /** Optional hook to record the latest alive state, e.g. to sync freshly added accessories. */
    onStateChange?: (alive: boolean) => void;
}

/**
 * Sets `StatusActive` on every service of the given accessories, adding the characteristic
 * where it is not present yet (skipping AccessoryInformation services, where StatusActive is
 * semantically inert). `active: false` signals HomeKit that the exposed values are stale
 * because the device connection was lost.
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

/**
 * Subscribes to the device's `alive$` stream (deduplicated with distinctUntilChanged) and
 * keeps the transport status of the device's accessories in sync on every state change:
 * - `false` (connection lost): log.warn + StatusActive=false on all services.
 * - `true` (reconnected): log.info + StatusActive=true on all services.
 *
 * esphome-ts v4 buffers an initial `false` per subscriber, so log lines are only emitted
 * after the first successful connection — the startup-offline case is covered by the
 * platform's own "could not be reached" warning.
 *
 * Returns the Subscription so callers can add it to their teardown aggregate.
 */
export const watchDeviceConnection = (
    host: string,
    device: AliveStreamSource,
    log: Logging,
    api: API,
    options: ConnectionWatchOptions,
): Subscription => {
    let everConnected = false;
    return device.alive$.pipe(distinctUntilChanged()).subscribe((alive) => {
        // Keep recording and applying every emission; only the log lines must not fire on
        // the buffered next(false) every subscriber receives at subscribe time.
        options.onStateChange?.(alive);
        if (alive) {
            if (everConnected) {
                log.info(`Connection to the esphome device ${host} re-established.`);
            }
            everConnected = true;
        } else if (everConnected) {
            log.warn(`Connection to the esphome device ${host} was lost. Values may be stale.`);
        }
        applyConnectionStatus(options.accessoriesOfDevice(), alive, api);
    });
};
