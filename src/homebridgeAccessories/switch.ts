import {SwitchComponent} from 'esphome-ts/dist';
import {CharacteristicEventTypes, CharacteristicSetCallback, CharacteristicValue} from 'hap-nodejs';
import {tap} from 'rxjs/operators';
import {PlatformAccessory} from 'homebridge';
import {Characteristic, Service} from '../index';

export const switchHelper = (component: SwitchComponent, accessory: PlatformAccessory): boolean => {

    let service = accessory.services.find((service) => service.UUID === Service.Switch.UUID);
    if (!service) {
        service = accessory.addService(new Service.Switch(component.name, ''));
    }

    component.state$.pipe(
        tap(() => service?.getCharacteristic(Characteristic.On)?.setValue(component.status)),
    ).subscribe();

    service.getCharacteristic(Characteristic.On)?.on(CharacteristicEventTypes.SET,
        (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
            if (component.status !== !!value) {
                !!value ? component.turnOn() : component.turnOff();
            }
            callback();
        });

    return true;
};
