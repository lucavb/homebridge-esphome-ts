import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import type { Observable } from 'rxjs';
import { concat, from, interval, EMPTY, Subscription } from 'rxjs';
import { catchError, filter, map, mergeMap, shareReplay, take, takeUntil, tap, timeout } from 'rxjs';
import { componentHelpers } from './homebridgeAccessories/componentHelpers.js';
import type { ComponentHelperOptions } from './homebridgeAccessories/componentBinding.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './constants.js';
import { applyConnectionStatus, watchDeviceConnection } from './shared/connectionStatus.js';
import { describeDeviceError, isTerminalDeviceError } from './shared/deviceErrors.js';
import type { DeviceErrorKind } from './shared/deviceErrors.js';
import { writeReadDataToLogFile } from './shared/index.js';
import { EspDevice } from 'esphome-ts';
import { discoverDevices } from './discovery.js';

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

const DEFAULT_RETRY_AFTER = 90_000;
const DEFAULT_DISCOVERY_TIMEOUT = 5_000; // milliseconds
/** Node clamps timer delays outside this range to 1 ms, which would become a reconnect hot loop. */
const MIN_RETRY_AFTER = 1_000;
const MAX_RETRY_AFTER = 2_147_483_647;

/** A usable timer delay in [MIN_RETRY_AFTER, MAX_RETRY_AFTER], or the fallback when unset/not a number. */
const retryDelay = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(Math.round(value), MIN_RETRY_AFTER), MAX_RETRY_AFTER)
        : fallback;

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
            this.espDevices.forEach((device: EspDevice) => device.terminate());
            this.subscription.unsubscribe();
        });
    }

    protected onHomebridgeDidFinishLaunching(): void {
        const configuredDevices = this.usableConfiguredDevices();
        let devices: Observable<IEsphomeDeviceConfig> = from(configuredDevices);
        if (this.config.discover) {
            const excludeConfigDevices: Set<string> = new Set();
            devices = concat(
                discoverDevices(this.config.discoveryTimeout ?? DEFAULT_DISCOVERY_TIMEOUT, this.log).pipe(
                    map((discoveredDevice) => {
                        const configDevice = configuredDevices.find(({ host }) => host === discoveredDevice.host);
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
                from(configuredDevices).pipe(filter(({ host }) => !excludeConfigDevices.has(host))),
            );
        }

        this.subscription.add(
            devices
                .pipe(
                    mergeMap((deviceConfig) => {
                        const rawHost: unknown = deviceConfig.host;
                        if (typeof rawHost !== 'string' || rawHost.trim() === '') {
                            this.log.error('A "devices" entry is missing a valid "host"; skipping it.');
                            return EMPTY;
                        }
                        const rawPassword: unknown = deviceConfig.password;
                        if (rawPassword !== undefined && rawPassword !== null && typeof rawPassword !== 'string') {
                            this.log.error(`The "password" configured for ${deviceConfig.host} must be a string.`);
                            return EMPTY;
                        }
                        const password = typeof rawPassword === 'string' ? rawPassword : undefined;
                        const rawPort: unknown = deviceConfig.port;
                        const port =
                            rawPort === undefined || rawPort === null
                                ? undefined
                                : typeof rawPort === 'number' || typeof rawPort === 'string'
                                  ? Number(rawPort)
                                  : Number.NaN;
                        if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
                            this.log.error(
                                `The "port" configured for ${deviceConfig.host} must be an integer between 1 and 65535.`,
                            );
                            return EMPTY;
                        }
                        const rawEncryptionKey: unknown = deviceConfig.encryptionKey;
                        if (
                            rawEncryptionKey !== undefined &&
                            rawEncryptionKey !== null &&
                            typeof rawEncryptionKey !== 'string'
                        ) {
                            this.log.error(`The "encryptionKey" configured for ${deviceConfig.host} must be a string.`);
                            return EMPTY;
                        }
                        const trimmedKey = typeof rawEncryptionKey === 'string' ? rawEncryptionKey.trim() : '';
                        if (typeof rawEncryptionKey === 'string' && rawEncryptionKey !== '' && trimmedKey === '') {
                            // A field left as spaces is a mistake; a plain empty string is the
                            // normal "unencrypted" state and stays silent.
                            this.log.warn(
                                `The "encryptionKey" configured for ${deviceConfig.host} is blank;` +
                                    ' treating the device as unencrypted.',
                            );
                        }
                        const encryptionKey = trimmedKey === '' ? undefined : trimmedKey;
                        const rawInvertFanDirection: unknown = deviceConfig.invertFanDirection;
                        if (
                            rawInvertFanDirection !== undefined &&
                            rawInvertFanDirection !== null &&
                            typeof rawInvertFanDirection !== 'boolean'
                        ) {
                            this.log.warn(
                                `The "invertFanDirection" configured for ${deviceConfig.host} must be a boolean;` +
                                    ' ignoring it.',
                            );
                        }
                        const invertFanDirection = rawInvertFanDirection === true;
                        if (encryptionKey !== undefined && password !== undefined && password !== '') {
                            this.log.warn(
                                `Both "password" and "encryptionKey" are configured for ${deviceConfig.host}.` +
                                    ' ESPHome uses one or the other.',
                            );
                        }

                        const rawRetryAfter = deviceConfig.retryAfter;
                        const globalRetryAfter = retryDelay(this.config.retryAfter, DEFAULT_RETRY_AFTER);
                        const retryAfter = retryDelay(rawRetryAfter, globalRetryAfter);
                        const roundedRetryAfter =
                            typeof rawRetryAfter === 'number' ? Math.round(rawRetryAfter) : Number.NaN;
                        if (rawRetryAfter !== undefined && retryAfter !== roundedRetryAfter) {
                            this.log.warn(
                                `The "retryAfter" configured for ${deviceConfig.host} is invalid;` +
                                    ` using ${retryAfter} ms.`,
                            );
                        }

                        let device: EspDevice;
                        try {
                            device = new EspDevice(
                                deviceConfig.host,
                                password,
                                port,
                                encryptionKey === undefined ? undefined : { encryptionKey },
                            );
                        } catch (error) {
                            const description = describeDeviceError(deviceConfig.host, error, {
                                encryptionKeyConfigured: encryptionKey !== undefined,
                            });
                            this.log.error(
                                description.message ?? `Could not create the esphome device ${deviceConfig.host}.`,
                                error,
                            );
                            return EMPTY;
                        }

                        // Track openings for terminate() on shutdown; devices were previously created
                        // but never pushed, making the shutdown loop a no-op.
                        this.espDevices.push(device);
                        if (this.config.debug) {
                            const dumpSubscription = writeReadDataToLogFile(deviceConfig.host, device, (error) => {
                                this.log.warn(
                                    `Writing the raw data for ${deviceConfig.host} to /tmp failed;` +
                                        ' no further debug dumps are written for this device.',
                                );
                                this.log.debug('debug dump write failed', error);
                            });
                            if (dumpSubscription) {
                                this.log('Writing the raw data from your ESP Device to /tmp');
                                this.subscription.add(dumpSubscription);
                            } else {
                                this.log.debug(
                                    `No socket to mirror for ${deviceConfig.host}; debug dumps are unavailable.`,
                                );
                            }
                        }

                        // esphome-ts latches rejected credentials and encryption mismatches as
                        // terminal (the config cannot change while connected), so stop the retry
                        // cadence and the discovery wait instead of logging futile attempts.
                        // The notifier must replay: esphome-ts tears the provided cadence down
                        // when the device connects and subscribes a fresh copy after the terminal
                        // failure disconnects it. A cold take(1) would have missed the error.
                        const terminalFailure$ = device.error$.pipe(
                            filter(isTerminalDeviceError),
                            take(1),
                            shareReplay({ bufferSize: 1, refCount: false }),
                        );
                        const warnedKinds = new Set<DeviceErrorKind>();
                        this.subscription.add(
                            device.error$.subscribe((error) => {
                                const description = describeDeviceError(deviceConfig.host, error, {
                                    encryptionKeyConfigured: encryptionKey !== undefined,
                                });
                                if (description.terminal) {
                                    this.log.error(
                                        description.message ?? `Error from esphome device ${deviceConfig.host}`,
                                    );
                                    return;
                                }
                                if (
                                    description.warnOnce &&
                                    description.message !== undefined &&
                                    !warnedKinds.has(description.kind)
                                ) {
                                    warnedKinds.add(description.kind);
                                    this.log.warn(description.message);
                                    return;
                                }
                                this.log.debug(`Error from esphome device ${deviceConfig.host}`, error);
                            }),
                        );
                        device.provideRetryObservable(
                            interval(retryAfter).pipe(
                                takeUntil(terminalFailure$),
                                tap(() => this.log.info(`Trying to reconnect now to device ${deviceConfig.host}`)),
                            ),
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
                            timeout({
                                first: 10 * 1000,
                                with: () => {
                                    this.log.warn(
                                        `The device under the host ${deviceConfig.host} could not be reached.`,
                                    );
                                    return device.discovery$.pipe(
                                        filter((value: boolean) => value),
                                        take(1),
                                    );
                                },
                            }),
                            takeUntil(terminalFailure$),
                            tap(() =>
                                this.addAccessories(device, deviceConfig.host, {
                                    invertFanDirection,
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

    /** Drops entries that are not objects; the per-field validation runs on every survivor. */
    private usableConfiguredDevices(): IEsphomeDeviceConfig[] {
        const rawDevices: unknown = this.config.devices;
        if (rawDevices !== undefined && !Array.isArray(rawDevices)) {
            this.log.error('The "devices" configuration must be an array; ignoring it.');
        }
        const entries: unknown[] = Array.isArray(rawDevices) ? rawDevices : [];
        const configured: IEsphomeDeviceConfig[] = [];
        for (const [index, entry] of entries.entries()) {
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
                this.log.error(`Skipping devices[${index}]: it is not an object.`);
                continue;
            }
            configured.push(entry as IEsphomeDeviceConfig);
        }
        return configured;
    }

    private addAccessories(device: EspDevice, host: string, options: ComponentHelperOptions = {}): void {
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
