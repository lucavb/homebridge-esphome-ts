import { API, Characteristic as HAPCharacteristic, PlatformAccessory, Service as HAPService } from 'homebridge';

export const PLUGIN_NAME = 'homebridge-esphome-ts';
export const PLATFORM_NAME = 'esphome';

export let UUIDGen: API['hap']['uuid'];
export let Accessory: typeof PlatformAccessory;
export let Service: typeof HAPService;
export let Characteristic: typeof HAPCharacteristic;

export const initHap = (api: API): void => {
    Accessory = api.platformAccessory;
    UUIDGen = api.hap.uuid;
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
};
