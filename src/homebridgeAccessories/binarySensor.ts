import type { API, Characteristic, PlatformAccessory, Service } from 'homebridge';
import { BinarySensorTypes, BinarySensorComponent } from 'esphome-ts';
import type { BaseComponent } from 'esphome-ts';

import { bindComponent } from './componentBinding.js';
import type { ComponentBinding } from './componentBinding.js';

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
    component: BaseComponent,
    accessory: PlatformAccessory,
    api: API,
): (() => void) | undefined => {
    if (!(component instanceof BinarySensorComponent)) {
        return undefined;
    }

    const homekitStuff = map(api).get(component.deviceClass);
    if (!homekitStuff) {
        return undefined;
    }

    const bindings: ComponentBinding[] = [
        {
            service: homekitStuff.service,
            name: component.name,
            characteristic: homekitStuff.characteristic,
            read: () => component.status,
            project: () => component.status,
        },
    ];

    return bindComponent(component, accessory, api, bindings);
};
