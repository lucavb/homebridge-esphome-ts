import {HomebridgePlatformAccessory} from 'homebridge-ts-helper';
import {SwitchComponent} from 'esphome-ts/dist';
import {Switch} from 'hap-nodejs/dist/lib/gen/HomeKit';
import {Characteristic, CharacteristicEventTypes, CharacteristicSetCallback, CharacteristicValue} from 'hap-nodejs';
import {tap} from 'rxjs/operators';

export const switchHelper = (component: SwitchComponent, accessory: HomebridgePlatformAccessory): void => {

    let service = accessory.services.find((service) => service.UUID === Switch.UUID);
    if (!service) {
        service = accessory.addService(new Switch(component.name, ''));
    }

    component.state$.pipe(
        tap(() => service?.getCharacteristic(Characteristic.On)?.setValue(component.status)),
    ).subscribe();

    service.getCharacteristic(Characteristic.On)?.on(CharacteristicEventTypes.SET,
        (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
            !!value ? component.turnOn() : component.turnOff();
            callback();
        });

};
