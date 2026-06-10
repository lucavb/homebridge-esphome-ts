import { CharacteristicEventTypes, CharacteristicGetCallback, PlatformAccessory } from 'homebridge';
import { BinarySensorComponent, BinarySensorTypes } from 'esphome-ts';
import { Subscription } from 'rxjs';
import { tap } from 'rxjs/operators';

import { Characteristic, Service } from '../hap';

type SupportedServices =
    | typeof Service.MotionSensor
    | typeof Service.LeakSensor
    | typeof Service.ContactSensor
    | typeof Service.SmokeSensor;
type SupportedCharacteristics =
    | typeof Characteristic.MotionDetected
    | typeof Characteristic.ContactSensorState
    | typeof Characteristic.SmokeDetected
    | typeof Characteristic.LeakDetected;

interface BinarySensorHomekit {
    characteristic: SupportedCharacteristics;
    service: SupportedServices;
}

const map = (): Map<BinarySensorTypes, BinarySensorHomekit> => {
    return new Map<BinarySensorTypes, BinarySensorHomekit>([
        [
            BinarySensorTypes.MOTION,
            {
                characteristic: Characteristic.MotionDetected,
                service: Service.MotionSensor,
            },
        ],
        [
            BinarySensorTypes.WINDOW,
            {
                characteristic: Characteristic.ContactSensorState,
                service: Service.ContactSensor,
            },
        ],
        [
            BinarySensorTypes.DOOR,
            {
                characteristic: Characteristic.ContactSensorState,
                service: Service.ContactSensor,
            },
        ],
        [
            BinarySensorTypes.SMOKE,
            {
                characteristic: Characteristic.SmokeDetected,
                service: Service.SmokeSensor,
            },
        ],
        [
            BinarySensorTypes.MOISTURE,
            {
                characteristic: Characteristic.LeakDetected,
                service: Service.LeakSensor,
            },
        ],
    ]);
};

export const binarySensorHelper = (
    component: BinarySensorComponent,
    accessory: PlatformAccessory,
): Subscription | false => {
    const homekitStuff = map().get(component.deviceClass);

    if (!homekitStuff) {
        return false;
    }

    const ServiceConstructor = homekitStuff.service;
    let service = accessory.services.find((existingService) => existingService.UUID === ServiceConstructor.UUID);
    if (!service) {
        service = accessory.addService(new ServiceConstructor(component.name, ''));
    }

    service
        .getCharacteristic(homekitStuff.characteristic)
        ?.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
            callback(null, component.status);
        });

    const subscription = component.state$
        .pipe(
            tap(() => {
                service?.getCharacteristic(homekitStuff.characteristic)?.updateValue(component.status);
            }),
        )
        .subscribe();

    return subscription;
};
