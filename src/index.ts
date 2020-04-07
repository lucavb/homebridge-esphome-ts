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

const PLUGIN_NAME = 'homebridge-esphome-ts';
const PLATFORM_NAME = 'esphome';

let Accessory: HomebridgePlatformAccessory;
let UUIDGen: typeof uuidFunctions;

export default (homebridge: HomebridgeApi) => {
    console.log('homebridge API version: ' + homebridge.version);

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
    }[]
}

export class EsphomePlatform extends HomebridgePlatform {

    protected readonly espDevices: EspDevice[] = [];

    constructor(protected readonly log: HomebridgeLogging,
                protected readonly config: IEsphomePlatformConfig,
                protected readonly api: HomebridgeApi) {
        super(log, config, api);
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
            const componentHelper = componentHelpers.get(component.getType);
            if (!componentHelper) {
                continue;
            }
            const uuid = UUIDGen.generate(component.name);
            let newAccessory = false;
            let accessory: HomebridgePlatformAccessory | undefined = this.accessories.find(
                (accessory) => accessory.UUID === uuid);
            if (!accessory) {
                accessory = new Accessory(component.name, uuid);
                newAccessory = true;
            }
            componentHelper(component, accessory);
            accessory.reachable = true;
            if (accessory && newAccessory) {
                this.accessories.push(accessory);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            }
        }
    }

    configureAccessory(accessory: HomebridgePlatformAccessory): void {
        accessory.reachable = false;
        this.accessories.push(accessory);
    }
}
