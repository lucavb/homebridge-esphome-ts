import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { concat, from, interval, Observable, of, Subscription } from 'rxjs';
import { catchError, filter, map, mergeMap, take, tap, timeout } from 'rxjs/operators';
import { componentHelpers } from './homebridgeAccessories/componentHelpers';
import { Accessory, PLATFORM_NAME, PLUGIN_NAME, UUIDGen } from './index';
// import { writeReadDataToLogFile } from './shared';
import { discoverDevices } from './discovery';
const { Client, Discovery } = require('@2colors/esphome-native-api');

interface IEsphomeDeviceConfig {
    host: string;
    port?: number;
    password?: string;
    encryptionKey?: string;
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
    // protected readonly espDevices: EspDevice[] = [];
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
        // this.api.on('shutdown', () => {
        //     this.espDevices.forEach((device: EspDevice) => device.terminate());
        //     this.subscription.unsubscribe();
        // });
    }

    protected onHomebridgeDidFinishLaunching(): void {
        const devices: Observable<IEsphomeDeviceConfig> = from(this.config.devices ?? []);
        // TODO: Reimplement discovery
        // if (this.config.discover) {
        //     const excludeConfigDevices: Set<string> = new Set();
        //     devices = concat(
        //         discoverDevices(this.config.discoveryTimeout ?? DEFAULT_DISCOVERY_TIMEOUT, this.log).pipe(
        //             map((discoveredDevice) => {
        //                 const configDevice = this.config.devices?.find(({ host }) => host === discoveredDevice.host);
        //                 let deviceConfig = discoveredDevice;
        //                 if (configDevice) {
        //                     excludeConfigDevices.add(configDevice.host);
        //                     deviceConfig = { ...discoveredDevice, ...configDevice };
        //                 }

        //                 return {
        //                     ...deviceConfig,
        //                     // Override hostname with ip address when available
        //                     // to avoid issues with mDNS resolution at OS level
        //                     host: discoveredDevice.address ?? discoveredDevice.host,
        //                 };
        //             }),
        //         ),
        //         // Feed into output remaining devices from config that haven't been discovered
        //         devices.pipe(filter(({ host }) => !excludeConfigDevices.has(host))),
        //     );
        // }

        if (this.config.discover) {
            const discovery = new Discovery();
            discovery.on('info', (info: any) => {
                const deviceConfig = this.config.devices?.find(
                    ({ host }) => host === info.address || host === info.host,
                );

                if (deviceConfig === undefined) return;

                let match: boolean = false;
                if (deviceConfig.host !== info.address && deviceConfig.host !== info.host) {
                    return;
                }

                const device = new Client({
                    host: deviceConfig.host,
                    port: deviceConfig.port ?? 6053,
                    encryptionKey: deviceConfig.encryptionKey, // Use encryption key
                    password: deviceConfig.password, // Insert password if you have any (Deprecated)
                    clientInfo: 'homebridge-esphome-ts',
                    reconnect: deviceConfig.retryAfter,
                    reconnectInterval: this.config.retryAfter ?? DEFAULT_RETRY_AFTER,
                });

                device.connect();

                if (this.config.debug) {
                    this.log('Writing the raw data from your ESP Device to /tmp');
                    // TODO: Fix Debugging
                    // writeReadDataToLogFile(deviceConfig.host, device);
                }
                // get accessories and listen for state changes

                device.on('newEntity', (entity: any) => {
                    this.attachAccessory(entity);
                });

                match = true;
                // TODO: log if we are unable to find a device

                this.log('Writing the raw data from your ESP Device to /tmp');
            });
            discovery.run();
        } else {
            this.config.devices?.forEach((deviceConfig) => {
                const device = new Client({
                    host: deviceConfig.host,
                    port: deviceConfig.port ?? 6053,
                    encryptionKey: deviceConfig.encryptionKey, // Use encryption key
                    password: deviceConfig.password, // Insert password if you have any (Deprecated)
                    clientInfo: 'homebridge-esphome-ts',
                    reconnect: deviceConfig.retryAfter,
                    reconnectInterval: this.config.retryAfter ?? DEFAULT_RETRY_AFTER,
                });

                device.connect();

                if (this.config.debug) {
                    this.log('Writing the raw data from your ESP Device to /tmp');
                    // TODO: Fix Debugging
                    // writeReadDataToLogFile(deviceConfig.host, device);
                }
                // get accessories and listen for state changes

                device.on('newEntity', (entity: any) => {
                    this.attachAccessory(entity);
                });
            });
        }
    }

    private attachAccessory(component: any): void {
        const componentHelper = componentHelpers.get(component.type);
        if (!componentHelper) {
            this.log(
                `${component.name} (${component.type}) is currently not supported. You might want to file an issue on Github.`,
            );
            return;
        }

        const uuid = UUIDGen.generate(component.config.key.toString());
        let newAccessory = false;

        let accessory: PlatformAccessory | undefined = this.accessories.find((accessory) => accessory.UUID === uuid);
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
            return;
        }

        this.log(`${component.name} discovered and setup.`);
        if (accessory && newAccessory) {
            this.log(`adding accessory ${component.name} ${accessory.UUID}`);
            this.accessories.push(accessory);
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
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
