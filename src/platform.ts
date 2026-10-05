import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import type { Observable } from 'rxjs';
import { concat, from, interval, EMPTY, Subscription } from 'rxjs';
import { TimeoutError, catchError, filter, map, mergeMap, take, tap, timeout } from 'rxjs';
import { componentHelpers } from './homebridgeAccessories/componentHelpers.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './constants.js';
import { applyConnectionStatus, watchDeviceConnection } from './shared/connectionStatus.js';
import { writeReadDataToLogFile } from './shared/index.js';
import { EspDevice, InvalidPasswordError } from 'esphome-ts';
import { discoverDevices } from './discovery.js';

interface IEsphomeDeviceConfig {
    host: string;
    port?: number;
    password?: string;
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

const DEFAULT_RETRY_AFTER = 90_000;
const DEFAULT_DISCOVERY_TIMEOUT = 5_000; // milliseconds

export class EsphomePlatform implements DynamicPlatformPlugin {
    protected readonly espDevices: EspDevice[] = [];
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
        this.blacklistSet = new Set<string>(this.config.blacklist ?? []);

        this.api.on('didFinishLaunching', () => {
            this.onHomebridgeDidFinishLaunching();
        });
        this.api.on('shutdown', () => {
            this.espDevices.forEach((device: EspDevice) => device.terminate());
            this.subscription.unsubscribe();
        });
    }

    protected onHomebridgeDidFinishLaunching(): void {
        let devices: Observable<IEsphomeDeviceConfig> = from(this.config.devices ?? []);
        if (this.config.discover) {
            const excludeConfigDevices: Set<string> = new Set();
            devices = concat(
                discoverDevices(this.config.discoveryTimeout ?? DEFAULT_DISCOVERY_TIMEOUT, this.log).pipe(
                    map((discoveredDevice) => {
                        const configDevice = this.config.devices?.find(({ host }) => host === discoveredDevice.host);
                        let deviceConfig = discoveredDevice;
                        if (configDevice) {
                            excludeConfigDevices.add(configDevice.host);
                            deviceConfig = { ...discoveredDevice, ...configDevice };
                        }

                        return {
                            ...deviceConfig,
                            // Override hostname with ip address when available
                            // to avoid issues with mDNS resolution at OS level
                            host: discoveredDevice.address ?? discoveredDevice.host,
                        };
                    }),
                ),
                // Feed into output remaining devices from config that haven't been discovered
                devices.pipe(filter(({ host }) => !excludeConfigDevices.has(host))),
            );
        }

        this.subscription.add(
            devices
                .pipe(
                    mergeMap((deviceConfig) => {
                        const device = new EspDevice(deviceConfig.host, deviceConfig.password, deviceConfig.port);
                        // Track openings for terminate() on shutdown; devices were previously created
                        // but never pushed, making the shutdown loop a no-op.
                        this.espDevices.push(device);
                        if (this.config.debug) {
                            this.log('Writing the raw data from your ESP Device to /tmp');
                            writeReadDataToLogFile(deviceConfig.host, device);
                        }
                        device.provideRetryObservable(
                            interval(deviceConfig.retryAfter ?? this.config.retryAfter ?? DEFAULT_RETRY_AFTER).pipe(
                                tap(() => this.log.info(`Trying to reconnect now to device ${deviceConfig.host}`)),
                            ),
                        );
                        this.subscription.add(
                            device.error$.subscribe((error) => {
                                if (error instanceof InvalidPasswordError) {
                                    this.log.error(
                                        `The esphome device ${deviceConfig.host} rejected your password.` +
                                            ' Please check the "password" configured for this device.',
                                    );
                                } else {
                                    this.log.debug(`Error from esphome device ${deviceConfig.host}`, error);
                                }
                            }),
                        );
                        this.subscription.add(
                            watchDeviceConnection(deviceConfig.host, device, this.log, this.api, {
                                accessoriesOfDevice: () => this.accessoriesByHost.get(deviceConfig.host) ?? [],
                                onStateChange: (alive) => this.aliveStateByHost.set(deviceConfig.host, alive),
                            }),
                        );
                        return device.discovery$.pipe(
                            filter((value: boolean) => value),
                            take(1),
                            timeout(10 * 1000),
                            tap(() => this.addAccessories(device, deviceConfig.host)),
                            catchError((err) => {
                                if (err instanceof TimeoutError) {
                                    this.log.warn(
                                        `The device under the host ${deviceConfig.host} could not be reached.`,
                                    );
                                }
                                return EMPTY;
                            }),
                        );
                    }),
                )
                .subscribe(),
        );
    }

    private addAccessories(device: EspDevice, host: string): void {
        for (const key of Object.keys(device.components)) {
            const component = device.components[key];
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
            const teardown = componentHelper(component, accessory, this.api);
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
        this.logIfDebug(device.components);
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
