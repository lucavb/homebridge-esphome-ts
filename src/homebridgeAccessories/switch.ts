import { CharacteristicEventTypes } from 'hap-nodejs';
import { tap } from 'rxjs/operators';
import { Characteristic, Service } from '../index';
import { SwitchComponent } from 'esphome-ts';
import { CharacteristicSetCallback, CharacteristicValue, PlatformAccessory } from 'homebridge';

export const switchHelper = (component: SwitchComponent, accessory: PlatformAccessory): boolean => {
    let service = accessory.services.find((service) => service.UUID === Service.Switch.UUID);
    if (!service) {
        service = accessory.addService(new Service.Switch(component.name, ''));
    }

    component.state$
        // @ts-ignore
        .pipe(tap(() => service?.getCharacteristic(Characteristic.On)?.setValue(component.status)))
        .subscribe();

    service
        .getCharacteristic(Characteristic.On)
        ?.on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
            if (component.status !== !!value) {
                !!value ? component.turnOn() : component.turnOff();
            }
            callback();
        });

    return true;
};
