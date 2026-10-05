import { tap } from 'rxjs';
import type { API, Characteristic, PlatformAccessory, Service } from 'homebridge';
import { BinarySensorTypes } from 'esphome-ts';
import type { BinarySensorComponent } from 'esphome-ts';

type SupportedServices =
    typeof Service.MotionSensor | typeof Service.LeakSensor | typeof Service.ContactSensor | typeof Service.SmokeSensor;
type SupportedCharacteristics =
    | typeof Characteristic.MotionDetected
    | typeof Characteristic.ContactSensorState
    | typeof Characteristic.SmokeDetected
    | typeof Characteristic.LeakDetected;

interface BinarySensorHomekit {
    characteristic: SupportedCharacteristics;
    service: SupportedServices;
}

const map = (api: API): Map<BinarySensorTypes, BinarySensorHomekit> => {
    const { Characteristic: CharacteristicClass, Service: ServiceClass } = api.hap;
    return new Map<BinarySensorTypes, BinarySensorHomekit>([
        [
            BinarySensorTypes.MOTION,
            {
                characteristic: CharacteristicClass.MotionDetected,
                service: ServiceClass.MotionSensor,
            },
        ],
        [
            BinarySensorTypes.WINDOW,
            {
                characteristic: CharacteristicClass.ContactSensorState,
                service: ServiceClass.ContactSensor,
            },
        ],
        [
            BinarySensorTypes.DOOR,
            {
                characteristic: CharacteristicClass.ContactSensorState,
                service: ServiceClass.ContactSensor,
            },
        ],
        [
            BinarySensorTypes.SMOKE,
            {
                characteristic: CharacteristicClass.SmokeDetected,
                service: ServiceClass.SmokeSensor,
            },
        ],
        [
            BinarySensorTypes.MOISTURE,
            {
                characteristic: CharacteristicClass.LeakDetected,
                service: ServiceClass.LeakSensor,
            },
        ],
    ]);
};

export const binarySensorHelper = (
    component: BinarySensorComponent,
    accessory: PlatformAccessory,
    api: API,
): boolean => {
    const homekitStuff = map(api).get(component.deviceClass);

    if (homekitStuff) {
        const ServiceConstructor = homekitStuff?.service;
        let service = accessory.services.find((service) => service.UUID === ServiceConstructor.UUID);
        if (!service) {
            service = accessory.addService(new ServiceConstructor(component.name, ''));
        }

        service.getCharacteristic(homekitStuff.characteristic)?.onGet(async () => component.status);

        component.state$
            .pipe(
                tap(() => {
                    service?.getCharacteristic(homekitStuff.characteristic)?.setValue(component.status);
                }),
            )
            .subscribe();
        return true;
    }
    return false;
};
