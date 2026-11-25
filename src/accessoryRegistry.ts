import type { API, Logging, PlatformAccessory } from 'homebridge';
import { EMPTY, Subscription } from 'rxjs';
import { catchError, tap } from 'rxjs';
import type { BaseComponent, ComponentType } from 'esphome-ts';

import { PLATFORM_NAME, PLUGIN_NAME } from './constants.js';
import type { ResolvedDeviceConfig } from './deviceConfig.js';
import type { DeviceSession } from './deviceSession.js';
import { componentHelpers } from './homebridgeAccessories/componentHelpers.js';
import type { ComponentHelper } from './homebridgeAccessories/componentHelpers.js';
import type { ComponentHelperOptions } from './homebridgeAccessories/componentBinding.js';
import { applyConnectionStatus } from './shared/connectionStatus.js';

/**
 * The Accessory registry module owns the HomeKit side of every Device (GLOSSARY: Accessory
 * registry): identity, cache restore, Homebridge registration, the Blacklist rule, Connection
 * status, and teardown. The platform supplies one resolved transport config and one Device
 * session per Device and never touches an Accessory itself.
 *
 * Identity is the Component name: `api.hap.uuid.generate(component.name)` names the
 * Accessory. This module is the single place that decides ownership of that name, so a second
 * Device exposing it is handled here rather than by whichever helper happens to run last.
 *
 * Teardown ownership: every binding teardown is keyed to the Accessory it bound, and every
 * session subscription to the Device it was bound for. Unregistering an Accessory runs its
 * teardowns; {@link AccessoryRegistry.stop} runs all of them, while registered Accessories
 * stay registered because Homebridge's cache is the durable state.
 */

export interface AccessoryRegistryDeps {
    readonly api: API;
    readonly log: Logging;
    /** Component names excluded from Accessory creation (GLOSSARY: Blacklist). */
    readonly blacklist: ReadonlySet<string>;
    /** Verbose bookkeeping goes to `log.debug` unless the platform's `debug` flag is set. */
    readonly debug: boolean;
    /** Defaults to the production helper table; specs inject fakes. */
    readonly helpers?: ReadonlyMap<ComponentType, ComponentHelper>;
}

export interface AccessoryRegistry {
    /** Adopts one Accessory restored from Homebridge's cache (`configureAccessory`). */
    restore(accessory: PlatformAccessory): void;
    /** Starts owning a Device's Accessories, driven by its session's alive and Components streams. */
    bind(device: ResolvedDeviceConfig, session: DeviceSession): void;
    /** Unsubscribes every session subscription and runs every binding teardown. Idempotent. */
    stop(): void;
}

export const createAccessoryRegistry = (deps: AccessoryRegistryDeps): AccessoryRegistry => {
    const { api, log } = deps;
    const helpers = deps.helpers ?? componentHelpers;

    /** Accessories by their Homebridge UUID; the identity lookup for create-or-restore. */
    const byUuid = new Map<string, PlatformAccessory>();
    /** Accessories grouped by the Device host that owns them, for Connection status. */
    const accessoriesByDevice = new Map<string, PlatformAccessory[]>();
    /** Binding teardowns per Accessory, run when it is unregistered or the registry stops. */
    const teardownsByAccessory = new Map<PlatformAccessory, Array<() => void>>();
    /**
     * The first Device to bind a UUID owns it for the process lifetime. The claim is not
     * persisted: `context.host` holds the resolved transport host, which Discovery replaces
     * with the mDNS address, so a DHCP move would look like a new Device. A stable Device id
     * is the prerequisite for persisting Accessory identity.
     */
    const claims = new Map<string, string>();
    /** Last Connection status per Device, used to catch up Accessories adopted after the emission. */
    const aliveByDevice = new Map<string, boolean>();
    const deviceSubscriptions: Subscription[] = [];
    let stopped = false;

    const logIfDebug = (message: string, ...parameters: unknown[]): void => {
        if (deps.debug) {
            log(message, parameters);
        } else {
            log.debug(message, parameters);
        }
    };

    const accessoriesFor = (host: string): PlatformAccessory[] => accessoriesByDevice.get(host) ?? [];

    const associate = (host: string, accessory: PlatformAccessory): void => {
        const existing = accessoriesByDevice.get(host);
        if (existing === undefined) {
            accessoriesByDevice.set(host, [accessory]);
            return;
        }
        if (!existing.includes(accessory)) {
            existing.push(accessory);
        }
    };

    const disassociate = (accessory: PlatformAccessory): void => {
        for (const [host, accessories] of accessoriesByDevice) {
            const remaining = accessories.filter((candidate) => candidate !== accessory);
            if (remaining.length === 0) {
                accessoriesByDevice.delete(host);
            } else if (remaining.length !== accessories.length) {
                accessoriesByDevice.set(host, remaining);
            }
        }
    };

    const runTeardowns = (accessory: PlatformAccessory): void => {
        const teardowns = teardownsByAccessory.get(accessory);
        if (teardowns === undefined) {
            return;
        }
        teardownsByAccessory.delete(accessory);
        for (const teardown of teardowns) {
            teardown();
        }
    };

    const unregister = (accessory: PlatformAccessory): void => {
        api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        byUuid.delete(accessory.UUID);
        claims.delete(accessory.UUID);
        disassociate(accessory);
        runTeardowns(accessory);
    };

    const applyStatus = (host: string): void => {
        applyConnectionStatus(accessoriesFor(host), aliveByDevice.get(host) ?? true, api);
    };

    const addAccessories = (components: ReadonlyArray<BaseComponent>, device: ResolvedDeviceConfig): void => {
        const options: ComponentHelperOptions = { invertFanDirection: device.invertFanDirection };
        for (const component of components) {
            if (deps.blacklist.has(component.name)) {
                logIfDebug(`not processing ${component.name} because it was blacklisted`);
                continue;
            }
            const helper = helpers.get(component.type);
            if (helper === undefined) {
                log(`${component.name} is currently not supported. You might want to file an issue on Github.`);
                continue;
            }

            const uuid = api.hap.uuid.generate(component.name);
            const claimedBy = claims.get(uuid);
            if (claimedBy !== undefined && claimedBy !== device.host) {
                log.error(
                    `Both ${claimedBy} and ${device.host} expose a component named "${component.name}". ` +
                        `HomeKit can host only one; keeping ${claimedBy}'s. Rename the component on one ` +
                        `device. (Blacklisting "${component.name}" would remove it from both.)`,
                );
                continue;
            }

            let accessory = byUuid.get(uuid);
            let newAccessory = false;
            if (accessory === undefined) {
                logIfDebug(`${component.name} must be a new accessory`);
                accessory = new api.platformAccessory(component.name, uuid);
                newAccessory = true;
            }

            const teardown = helper(component, accessory, api, options);
            if (teardown === undefined) {
                log(`${component.name} could not be mapped to HomeKit. Please file an issue on Github.`);
                if (!newAccessory) {
                    unregister(accessory);
                }
                continue;
            }

            const teardowns = teardownsByAccessory.get(accessory) ?? [];
            teardowns.push(teardown);
            teardownsByAccessory.set(accessory, teardowns);

            // Registration key so a cached Accessory re-associates with this host on restore.
            accessory.context.host = device.host;

            log(`${component.name} discovered and setup.`);
            if (newAccessory) {
                byUuid.set(uuid, accessory);
                api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
            claims.set(uuid, device.host);
            // One Accessory has one owner: a cached Accessory can still sit in its previous
            // host's list, and the losing side of a claim keeps its alive$ watch. Drop the stale
            // association so only the owning Device drives Connection status.
            disassociate(accessory);
            associate(device.host, accessory);
        }
        logIfDebug('Device components', components);
        // Keep freshly added Accessories in sync with the last known Connection status.
        applyStatus(device.host);
    };

    return {
        restore(accessory: PlatformAccessory): void {
            if (stopped) {
                return;
            }
            if (deps.blacklist.has(accessory.displayName)) {
                api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                logIfDebug(`unregistered ${accessory.displayName} because it was blacklisted`);
                return;
            }

            const adopted = byUuid.get(accessory.UUID);
            if (adopted === undefined) {
                byUuid.set(accessory.UUID, accessory);
            } else if (adopted !== accessory) {
                // Homebridge hands over every cached entry; one that reuses an adopted UUID is
                // not the object the bridge owns, so it must not join the device lists.
                logIfDebug(`ignoring a second cached accessory for ${accessory.displayName}`);
                return;
            }

            const host = accessory.context.host; // persisted at registration; older caches may lack it
            if (typeof host === 'string') {
                associate(host, accessory);
            }
            logIfDebug(`cached accessory ${accessory.displayName} was added`);
        },

        bind(device: ResolvedDeviceConfig, session: DeviceSession): void {
            if (stopped) {
                return;
            }
            const host = device.host;
            const subscription = new Subscription();
            subscription.add(
                session.alive$.subscribe((alive) => {
                    aliveByDevice.set(host, alive);
                    applyStatus(host);
                }),
            );
            subscription.add(
                session.components$
                    .pipe(
                        tap((components) => addAccessories(components, device)),
                        catchError((error: unknown) => {
                            log.error(`Error while discovering or setting up accessories for device ${host}.`, error);
                            return EMPTY;
                        }),
                    )
                    .subscribe(),
            );
            deviceSubscriptions.push(subscription);
        },

        stop(): void {
            if (stopped) {
                return;
            }
            stopped = true;
            for (const subscription of deviceSubscriptions) {
                subscription.unsubscribe();
            }
            deviceSubscriptions.length = 0;
            for (const accessory of [...teardownsByAccessory.keys()]) {
                runTeardowns(accessory);
            }
            byUuid.clear();
            accessoriesByDevice.clear();
            aliveByDevice.clear();
            claims.clear();
        },
    };
};
