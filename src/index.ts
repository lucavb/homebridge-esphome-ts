import {API, Characteristic as HAPCharacteristic, PlatformAccessory, Service as HAPService} from 'homebridge';
import * as uuidFunctions from 'hap-nodejs/dist/lib/util/uuid';
import {EsphomePlatform} from './platform';

export const PLUGIN_NAME = 'homebridge-esphome-ts';
export const PLATFORM_NAME = 'esphome';

export let UUIDGen: typeof uuidFunctions;
export let Accessory: typeof PlatformAccessory;
export let Service: typeof HAPService;
export let Characteristic: typeof HAPCharacteristic;

export default (homebridge: API) => {
    // Accessory must be created from PlatformAccessory Constructor
    Accessory = homebridge.platformAccessory;

    // Service and Characteristic are from hap-nodejs
    UUIDGen = homebridge.hap.uuid;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    // For platform plugin to be considered as dynamic platform plugin,
    // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
    homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, EsphomePlatform);
};
