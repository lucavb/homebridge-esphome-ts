import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { EspDevice } from 'esphome-ts';
import { concat, from, interval, Observable, of, Subscription } from 'rxjs';
import { catchError, filter, map, mergeMap, take, tap, timeout } from 'rxjs/operators';

import { DeviceOptions, PlatformOptions } from './config';
import { discoverDevices } from './discovery';
import { componentHelpers } from './homebridgeAccessories/componentHelpers';
import { Accessory, initHap, PLATFORM_NAME, PLUGIN_NAME, UUIDGen } from './hap';
import { writeReadDataToLogFile } from './shared';

export { PLATFORM_NAME, PLUGIN_NAME } from './hap';

export class EsphomePlatform implements DynamicPlatformPlugin {
    protected readonly espDevices: EspDevice[] = [];
    protected readonly options: PlatformOptions;
    protected readonly blacklistSet: Set<string>;
    protected readonly subscription = new Subscription();
    protected readonly accessories: PlatformAccessory[] = [];

    constructor(
        protected readonly log: Logging,
        config: PlatformConfig,
        protected readonly api: API,
    ) {
        initHap(api);
        this.options = new PlatformOptions(config);
        this.log('starting esphome');

        if (!this.options.devices.length && !this.options.discover) {
            this.log.error(
                'You did not specify a devices array and discovery is ' +
                    'disabled! Esphome will not provide any accessories',
            );
        }

        this.blacklistSet = new Set<string>(this.options.blacklist);

        this.api.on('didFinishLaunching', () => {
            this.onHomebridgeDidFinishLaunching();
        });
        this.api.on('shutdown', () => {
            this.espDevices.forEach((device: EspDevice) => device.terminate());
            this.subscription.unsubscribe();
        });
    }

    protected onHomebridgeDidFinishLaunching(): void {
        let devices: Observable<DeviceOptions> = from(this.options.devices);
        if (this.options.discover) {
            const excludeConfigDevices: Set<string> = new Set();
            devices = concat(
                discoverDevices(this.options.discoveryTimeout, this.log).pipe(
                    map((discoveredDevice) => {
                        const configDevice = this.options.devices.find(({ host }) => host === discoveredDevice.host);
                        let deviceConfig = discoveredDevice;
                        if (configDevice) {
                            excludeConfigDevices.add(configDevice.host);
                            deviceConfig = { ...discoveredDevice, ...configDevice };
                        }

                        return {
                            ...deviceConfig,
                            host: discoveredDevice.address ?? discoveredDevice.host,
                        };
                    }),
                ),
                devices.pipe(filter(({ host }) => !excludeConfigDevices.has(host))),
            );
        }

        this.subscription.add(
            devices
                .pipe(
                    mergeMap((deviceConfig) => {
                        const device = new EspDevice(deviceConfig.host, deviceConfig.password, deviceConfig.port);
                        this.espDevices.push(device);
                        if (this.options.debug) {
                            this.log('Writing the raw data from your ESP Device to /tmp');
                            const debugSubscription = writeReadDataToLogFile(deviceConfig.host, device);
                            if (debugSubscription) {
                                this.subscription.add(debugSubscription);
                            }
                        }
                        device.provideRetryObservable(
                            interval(deviceConfig.retryAfter ?? this.options.retryAfter).pipe(
                                tap(() => this.log.info(`Trying to reconnect now to device ${deviceConfig.host}`)),
                            ),
                        );
                        return device.discovery$.pipe(
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
                (existingAccessory) => existingAccessory.UUID === uuid,
            );
            if (!accessory) {
                this.logIfDebug(`${component.name} must be a new accessory`);
                accessory = new Accessory(component.name, uuid);
                newAccessory = true;
            }
            const helperResult = componentHelper(component, accessory);
            if (helperResult === false) {
                this.log(`${component.name} could not be mapped to HomeKit. Please file an issue on Github.`);
                if (!newAccessory) {
                    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                }
                continue;
            }

            this.subscription.add(helperResult);

            this.log(`${component.name} discovered and setup.`);
            if (newAccessory) {
                this.accessories.push(accessory);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
        }
        this.logIfDebug(JSON.stringify(device.components));
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

    private logIfDebug(msg: string, ...parameters: unknown[]): void {
        if (this.options.debug) {
            this.log(msg, ...parameters);
        } else {
            this.log.debug(msg, ...parameters);
        }
    }
}
