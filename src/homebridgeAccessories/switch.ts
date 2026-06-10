import {
    CharacteristicEventTypes,
    CharacteristicSetCallback,
    CharacteristicValue,
    PlatformAccessory,
} from 'homebridge';
import { SwitchComponent } from 'esphome-ts';
import { Subscription } from 'rxjs';
import { tap } from 'rxjs/operators';

import { Characteristic, Service } from '../hap';

export const switchHelper = (component: SwitchComponent, accessory: PlatformAccessory): Subscription | false => {
    let service = accessory.services.find((existingService) => existingService.UUID === Service.Switch.UUID);
    if (!service) {
        service = accessory.addService(new Service.Switch(component.name, ''));
    }

    const subscription = component.state$
        .pipe(tap(() => service?.getCharacteristic(Characteristic.On)?.updateValue(component.status)))
        .subscribe();

    service
        .getCharacteristic(Characteristic.On)
        ?.on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
            if (component.status !== !!value) {
                if (value) {
                    component.turnOn();
                } else {
                    component.turnOff();
                }
            }
            callback();
        });

    return subscription;
};
