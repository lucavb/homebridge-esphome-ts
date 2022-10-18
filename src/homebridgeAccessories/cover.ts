import { CoverComponent } from 'esphome-ts';
import {
    CharacteristicSetCallback,
    CharacteristicEventTypes,
    CharacteristicValue,
    PlatformAccessory
} from 'homebridge';
import { Characteristic, Service } from '../index';

export const coverHelper = (component: CoverComponent, accessory: PlatformAccessory): boolean => {
    if (component.assumedState) {
        let methods = [component.open, component.close, component.stop];
        let labels : { [key: string]: string; } = { "open" : '\u{25B2}' , "close" : '\u{25BC}' , "stop" : '\u{23F9}' }
        methods.forEach((method) => {
            let service = accessory.services.find((service) => service.UUID === Service.Switch.UUID && service.subtype === method.name);
            if (!service) {
                service = accessory.addService(new Service.Switch(labels[method.name], method.name))
            }
            let state = false;
            service.getCharacteristic(Characteristic.On)?.on(
                CharacteristicEventTypes.GET,
                (callback: CharacteristicSetCallback) => {
                    callback(null, state);
                },
            );
            service.getCharacteristic(Characteristic.On)?.on(
                CharacteristicEventTypes.SET,
                (on: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    state = on as boolean;
                    if (state === true) {
                        method.call(component);
                        setTimeout(function () {
                            service?.setCharacteristic(Characteristic.On, false);
                        }.bind(this), 200);
                    }
                    callback();
                },
            );
        });
        return true;
    } else {
        // TODO actual HomeKit cover
        return false;
    }
};
