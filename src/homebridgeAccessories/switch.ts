import { tap } from 'rxjs';
import type { API, CharacteristicValue, PlatformAccessory } from 'homebridge';
import { HAPStatus } from 'homebridge';
import type { SwitchComponent } from 'esphome-ts';

export const switchHelper = (component: SwitchComponent, accessory: PlatformAccessory, api: API): boolean => {
    const { Characteristic: CharacteristicClass, Service } = api.hap;
    let service = accessory.services.find((service) => service.UUID === Service.Switch.UUID);
    if (!service) {
        service = accessory.addService(new Service.Switch(component.name, ''));
    }

    component.state$
        .pipe(tap(() => service?.getCharacteristic(CharacteristicClass.On)?.setValue(component.status)))
        .subscribe();

    service.getCharacteristic(CharacteristicClass.On)?.onSet(async (value: CharacteristicValue) => {
        try {
            if (component.status !== !!value) {
                if (value) {
                    component.turnOn();
                } else {
                    component.turnOff();
                }
            }
        } catch {
            throw new api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
    });

    return true;
};
