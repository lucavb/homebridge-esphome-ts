import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import type { Observable } from 'rxjs';
import { concat, defer, from, EMPTY, Subscription } from 'rxjs';
import { catchError, filter, map, mergeMap, tap } from 'rxjs';
import type { BaseComponent } from 'esphome-ts';
import { EspDevice } from 'esphome-ts';

import { componentHelpers } from './homebridgeAccessories/componentHelpers.js';
import type { ComponentHelperOptions } from './homebridgeAccessories/componentBinding.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './constants.js';
import { applyConnectionStatus } from './shared/connectionStatus.js';
import { writeReadDataToLogFile } from './shared/index.js';
import { startDeviceSession } from './deviceSession.js';
import type { DebugDumpWriter } from './deviceSession.js';
import { discoverDevices } from './discovery.js';
import { createDiscoveryConfigMerge, readDeviceEntries, resolveDeviceConfig } from './deviceConfig.js';
import type { DeviceConfigDefaults, ResolvedDeviceConfig } from './deviceConfig.js';

interface IEsphomeDeviceConfig {
    host: string;
    port?: number;
    password?: string;
    /** Base64-encoded 32-byte Noise PSK from ESPHome's `api: encryption: key:`. */
    encryptionKey?: string;
    /** Swap HomeKit clockwise/counter-clockwise for fans whose forward/reverse wiring is inverted. */
    invertFanDirection?: boolean;
    retryAfter?: number;
}

interface IEsphomePlatformConfig extends PlatformConfig {
    devices?: IEsphomeDeviceConfig[];
    blacklist?: string[];
    debug?: boolean;
    retryAfter?: number;
    discover?: boolean;
    discoveryTimeout?: number;
}

const DEFAULT_DISCOVERY_TIMEOUT = 5_000; // milliseconds

const isResolvedDeviceConfig = (config: ResolvedDeviceConfig | undefined): config is ResolvedDeviceConfig =>
    config !== undefined;

/** The debug dump reaches into the library's socket; only a real EspDevice can be tapped. */
const writeEspDeviceDebugDump: DebugDumpWriter = (host, device, onWriteError) =>
    device instanceof EspDevice ? writeReadDataToLogFile(host, device, onWriteError) : undefined;

export class EsphomePlatform implements DynamicPlatformPlugin {
    protected readonly blacklistSet: Set<string>;
    protected readonly subscription: Subscription;
    protected readonly accessories: PlatformAccessory[] = [];
    /** Accessories previously set up from a device's components, keyed by its configured host.
     * Cached accessories re-associate with their host via `accessory.context.host` when they
     * are restored from Homebridge's disk cache in `configureAccessory`. */
    protected readonly accessoriesByHost = new Map<string, PlatformAccessory[]>();
    /** Last known alive state per host, to keep freshly added accessories in sync. */
    protected readonly aliveStateByHost = new Map<string, boolean>();

    constructor(
        protected readonly log: Logging,
        protected readonly config: IEsphomePlatformConfig,
        protected readonly api: API,
        /** Test seam: specs inject a fake session without mocking the module. */
        protected readonly startSession: typeof startDeviceSession = startDeviceSession,
    ) {
        this.subscription = new Subscription();
        this.log('starting esphome');
        if (!Array.isArray(this.config.devices) && !this.config.discover) {
            this.log.error(
                'You did not specify a devices array and discovery is ' +
                    'disabled! Esphome will not provide any accessories',
            );
            this.config.devices = [];
        }
        const rawBlacklist: unknown = this.config.blacklist;
        if (rawBlacklist !== undefined && !Array.isArray(rawBlacklist)) {
            this.log.warn('The "blacklist" configuration must be an array; ignoring it.');
        }
        this.blacklistSet = new Set<string>(
            Array.isArray(rawBlacklist) ? rawBlacklist.filter((name): name is string => typeof name === 'string') : [],
        );

        this.api.on('didFinishLaunching', () => {
            this.onHomebridgeDidFinishLaunching();
        });
        this.api.on('shutdown', () => {
            // Each session's stop is a teardown on this aggregate: it terminates the Device,
            // unsubscribes its lifecycle streams, and completes components$/alive$.
            this.subscription.unsubscribe();
        });
    }

    protected onHomebridgeDidFinishLaunching(): void {
        const rawDevices = readDeviceEntries(this.config.devices, this.log);
        const defaults: DeviceConfigDefaults = { globalRetryAfter: this.config.retryAfter };
        let devices: Observable<ResolvedDeviceConfig>;
        if (this.config.discover) {
            const merge = createDiscoveryConfigMerge(rawDevices, defaults, this.log);
            devices = concat(
                discoverDevices(this.config.discoveryTimeout ?? DEFAULT_DISCOVERY_TIMEOUT, this.log).pipe(
                    map((discovered) => merge.merge(discovered)),
                    filter(isResolvedDeviceConfig),
                ),
                // Feed into output remaining devices from config that haven't been discovered.
                // defer keeps the not-yet-merged set read at the close of the discovery window.
                defer(() => from(merge.remaining())),
            );
        } else {
            devices = from(rawDevices).pipe(
                map((raw) => resolveDeviceConfig(raw, defaults, this.log)),
                filter(isResolvedDeviceConfig),
            );
        }

        this.subscription.add(
            devices
                .pipe(
                    mergeMap((deviceConfig) => {
                        const session = this.startSession(deviceConfig, {
                            log: this.log,
                            writeDebugDump: this.config.debug ? writeEspDeviceDebugDump : undefined,
                        });
                        this.subscription.add(session.stop);
                        this.subscription.add(
                            session.alive$.subscribe((alive) => {
                                this.aliveStateByHost.set(deviceConfig.host, alive);
                                applyConnectionStatus(
                                    this.accessoriesByHost.get(deviceConfig.host) ?? [],
                                    alive,
                                    this.api,
                                );
                            }),
                        );
                        return session.components$.pipe(
                            tap((components) =>
                                this.addAccessories(components, deviceConfig.host, {
                                    invertFanDirection: deviceConfig.invertFanDirection,
                                }),
                            ),
                            catchError((error: unknown) => {
                                this.log.error(
                                    `Error while discovering or setting up accessories for device ${deviceConfig.host}.`,
                                    error,
                                );
                                return EMPTY;
                            }),
                        );
                    }),
                )
                .subscribe(),
        );
    }

    private addAccessories(
        components: ReadonlyArray<BaseComponent>,
        host: string,
        options: ComponentHelperOptions = {},
    ): void {
        for (const component of components) {
            if (this.blacklistSet.has(component.name)) {
                this.logIfDebug(`not processing ${component.name} because it was blacklisted`);
                continue;
            }
            const componentHelper = componentHelpers.get(component.type);
            if (!componentHelper) {
                this.log(`${component.name} is currently not supported. You might want to file an issue on Github.`);
                continue;
            }
            const uuid = this.api.hap.uuid.generate(component.name);
            let newAccessory = false;
            let accessory: PlatformAccessory | undefined = this.accessories.find(
                (accessory) => accessory.UUID === uuid,
            );
            if (!accessory) {
                this.logIfDebug(`${component.name} must be a new accessory`);
                accessory = new this.api.platformAccessory(component.name, uuid);
                newAccessory = true;
            }
            const teardown = componentHelper(component, accessory, this.api, options);
            if (!teardown) {
                this.log(`${component.name} could not be mapped to HomeKit. Please file an issue on Github.`);
                if (!newAccessory) {
                    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                }
                continue;
            }
            this.subscription.add(teardown);

            // Registration key so a cached accessory re-associates with this host on restore.
            accessory.context.host = host;

            this.log(`${component.name} discovered and setup.`);
            if (accessory && newAccessory) {
                this.accessories.push(accessory);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
            const hostAccessories = this.accessoriesByHost.get(host) ?? [];
            if (!hostAccessories.includes(accessory)) {
                hostAccessories.push(accessory);
                this.accessoriesByHost.set(host, hostAccessories);
            }
        }
        this.logIfDebug(components);
        // Keep freshly added accessories in sync with the last known connection state of this device.
        applyConnectionStatus(
            this.accessoriesByHost.get(host) ?? [],
            this.aliveStateByHost.get(host) ?? true,
            this.api,
        );
    }

    public configureAccessory(accessory: PlatformAccessory): void {
        if (!this.blacklistSet.has(accessory.displayName)) {
            // Homebridge may hand the same cached accessory over twice; guard against duplicates.
            if (!this.accessories.includes(accessory)) {
                this.accessories.push(accessory);
            }
            // Re-associate the cached accessory with its host for connection-status sync.
            const host = accessory.context.host; // persisted at registration; older disk caches may lack it
            if (typeof host === 'string') {
                const hostAccessories = this.accessoriesByHost.get(host) ?? [];
                if (!hostAccessories.includes(accessory)) {
                    hostAccessories.push(accessory);
                    this.accessoriesByHost.set(host, hostAccessories);
                }
            }
            this.logIfDebug(`cached accessory ${accessory.displayName} was added`);
        } else {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.logIfDebug(`unregistered ${accessory.displayName} because it was blacklisted`);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- kept from the original logging contract
    private logIfDebug(msg?: any, ...parameters: unknown[]): void {
        if (this.config.debug) {
            this.log(msg, parameters);
        } else {
            this.log.debug(msg, parameters);
        }
    }
}
