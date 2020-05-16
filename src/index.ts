import {
    HomebridgeApi,
    HomebridgeLogging,
    HomebridgePlatform,
    HomebridgePlatformAccessory,
    IPlatformConfig,
} from 'homebridge-ts-helper';
import {filter, take, tap} from 'rxjs/operators';
import * as uuidFunctions from 'hap-nodejs/dist/lib/util/uuid';
import {componentHelpers} from './homebridgeAccessories/componentHelpers';
import {EspDevice} from 'esphome-ts/dist';
import {fromEvent, Subscription} from 'rxjs';

const PLUGIN_NAME = 'homebridge-esphome-ts';
const PLATFORM_NAME = 'esphome';

let Accessory: HomebridgePlatformAccessory;
let UUIDGen: typeof uuidFunctions;

export default (homebridge: HomebridgeApi) => {

    // Accessory must be created from PlatformAccessory Constructor
    Accessory = homebridge.platformAccessory;

    // Service and Characteristic are from hap-nodejs
    UUIDGen = homebridge.hap.uuid;


    // For platform plugin to be considered as dynamic platform plugin,
    // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
    homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, EsphomePlatform, true);
};

interface IEsphomePlatformConfig extends IPlatformConfig {
    devices: {
        host: string;
        password?: string;
        port?: number;
    }[],
    blacklist?: string[];
    debug?: boolean;
}

export class EsphomePlatform extends HomebridgePlatform {

    protected readonly espDevices: EspDevice[] = [];

    protected readonly blacklistSet: Set<string>;

    protected readonly subscription: Subscription;

    constructor(protected readonly log: HomebridgeLogging,
                protected readonly config: IEsphomePlatformConfig,
                protected readonly api: HomebridgeApi) {
        super(log, config, api);
        this.subscription = new Subscription();
        this.log('starting esphome');
        if (!Array.isArray(this.config.devices)) {
            this.log.error('You did not specify a devices array! Esphome will not provide any accessories');
            this.config.devices = [];
        }
        this.blacklistSet = new Set<string>(this.config.blacklist ?? []);

        fromEvent(this.api, 'shutdown').pipe(
            take(1),
            tap(() => this.espDevices.forEach((device: EspDevice) => device.terminate())),
            tap(() => this.subscription.unsubscribe()),
        ).subscribe();
    }

    protected onHomebridgeDidFinishLaunching(): void {
        this.config.devices.forEach((deviceConfig) => {
            const device = new EspDevice(deviceConfig.host, deviceConfig.password, deviceConfig.port);
            device.discovery$.pipe(
                filter(((value: boolean) => value)),
                take(1),
                tap(() => {
                    this.addAccessories(device);
                }),
            ).subscribe();
            this.espDevices.push(device);
        });
    }

    private addAccessories(device: EspDevice): void {
        for (const key of Object.keys(device.components)) {
            const component = device.components[key];
            if (this.blacklistSet.has(component.name)) {
                this.logIfDebug(`not processing ${component.name} because it was blacklisted`);
                continue;
            }
            const componentHelper = componentHelpers.get(component.getType);
            if (!componentHelper) {
                this.log(`${component.name} is currently not supported. You might want to file an issue on Github.`);
                continue;
            }
            const uuid = UUIDGen.generate(component.name);
            let newAccessory = false;
            let accessory: HomebridgePlatformAccessory | undefined = this.accessories.find(
                (accessory) => accessory.UUID === uuid);
            if (!accessory) {
                this.logIfDebug(`must be a new accessory`);
                accessory = new Accessory(component.name, uuid);
                newAccessory = true;
            }
            componentHelper(component, accessory);
            accessory.reachable = true;
            this.subscription.add(device.alive$.pipe(
                tap((val) => accessory!.reachable = val),
            ).subscribe());

            this.log(`${component.name} discovered and setup.`);
            if (accessory && newAccessory) {
                this.accessories.push(accessory);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
        }
        this.logIfDebug(device.components);
    }

    configureAccessory(accessory: HomebridgePlatformAccessory): void {
        if (!this.blacklistSet.has(accessory.displayName)) {
            accessory.reachable = false;
            this.accessories.push(accessory);
            this.logIfDebug(`cached accessory ${accessory.displayName} was added`);
        } else {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.logIfDebug(`unregistered ${accessory.displayName} because it was blacklisted`);
        }
    }

    private logIfDebug(msg?: any, parameters?: any[]): void {
        if (this.config.debug) {
            this.log(msg, parameters);
        } else {
            this.log.debug(msg, parameters);
        }
    }
}
