import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { concat, from, interval, Observable, of, Subscription } from 'rxjs';
import { catchError, filter, map, mergeMap, take, tap, timeout } from 'rxjs/operators';
import { componentHelpers } from './homebridgeAccessories/componentHelpers';
import { Accessory, PLATFORM_NAME, PLUGIN_NAME, UUIDGen } from './index';
import { writeReadDataToLogFile } from './shared';
import { EspDevice } from 'esphome-ts';
import { discoverDevices } from './discovery';

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
                    // @ts-ignore
                    mergeMap((deviceConfig) => {
                        const device = new EspDevice(deviceConfig.host, deviceConfig.password, deviceConfig.port);
                        if (this.config.debug) {
                            this.log('Writing the raw data from your ESP Device to /tmp');
                            writeReadDataToLogFile(deviceConfig.host, device);
                        }
                        device.provideRetryObservable(
                            // @ts-ignore
                            interval(deviceConfig.retryAfter ?? this.config.retryAfter ?? DEFAULT_RETRY_AFTER).pipe(
                                tap(() => this.log.info(`Trying to reconnect now to device ${deviceConfig.host}`)),
                            ),
                        );
                        return device.discovery$.pipe(
                            // @ts-ignore
                            filter((value: boolean) => value),
                            take(1),
                            timeout(10 * 1000),
                            tap(() => this.addAccessories(device)),
                            catchError((err) => {
                                if (err.name === 'TimeoutError') {
                                    this.log.warn(
                                        `The device under the host ${deviceConfig.host} could not be reached.`,
                                    );
                                }
                                return of(err);
                            }),
                        );
                    }),
                )
                .subscribe(),
        );
    }

    private addAccessories(device: EspDevice): void {
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
            const uuid = UUIDGen.generate(component.name);
            let newAccessory = false;
            let accessory: PlatformAccessory | undefined = this.accessories.find(
                (accessory) => accessory.UUID === uuid,
            );
            if (!accessory) {
                this.logIfDebug(`${component.name} must be a new accessory`);
                accessory = new Accessory(component.name, uuid);
                newAccessory = true;
            }
            if (!componentHelper(component, accessory)) {
                this.log(`${component.name} could not be mapped to HomeKit. Please file an issue on Github.`);
                if (!newAccessory) {
                    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                }
                continue;
            }

            this.log(`${component.name} discovered and setup.`);
            if (accessory && newAccessory) {
                this.accessories.push(accessory);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
        }
        this.logIfDebug(device.components);
    }

    public configureAccessory(accessory: PlatformAccessory): void {
        if (!this.blacklistSet.has(accessory.displayName)) {
            this.accessories.push(accessory);
            this.logIfDebug(`cached accessory ${accessory.displayName} was added`);
        } else {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.logIfDebug(`unregistered ${accessory.displayName} because it was blacklisted`);
        }
    }

    private logIfDebug(msg?: any, ...parameters: unknown[]): void {
        if (this.config.debug) {
            this.log(msg, parameters);
        } else {
            this.log.debug(msg, parameters);
        }
    }
}
