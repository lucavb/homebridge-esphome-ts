import {CharacteristicEventTypes, CharacteristicGetCallback} from 'hap-nodejs';
import {HomebridgePlatformAccessory} from 'homebridge-ts-helper';
import {
    ContactSensor,
    ContactSensorState,
    LeakDetected,
    LeakSensor,
    MotionDetected,
    MotionSensor,
    SmokeDetected,
    SmokeSensor,
} from 'hap-nodejs/dist/lib/gen/HomeKit';
import {tap} from 'rxjs/operators';
import {BinarySensorComponent} from 'esphome-ts/dist';
import {BinarySensorTypes} from 'esphome-ts/dist/components/binarySensorTypes';

type SupportedServices = typeof MotionSensor | typeof LeakSensor | typeof ContactSensor | typeof SmokeSensor;
type SupportedCharacteristics =
    typeof MotionDetected
    | typeof ContactSensorState
    | typeof SmokeDetected
    | typeof LeakDetected;

interface BinarySensorHomekit {
    characteristic: SupportedCharacteristics,
    service: SupportedServices;
}

const map = new Map<BinarySensorTypes, BinarySensorHomekit>([
    [BinarySensorTypes.MOTION, {
        characteristic: MotionDetected,
        service: MotionSensor,
    }],
    [BinarySensorTypes.WINDOW, {
        characteristic: ContactSensorState,
        service: ContactSensor,
    }],
    [BinarySensorTypes.DOOR, {
        characteristic: ContactSensorState,
        service: ContactSensor,
    }],
    [BinarySensorTypes.SMOKE, {
        characteristic: SmokeDetected,
        service: SmokeSensor,
    }],
    [BinarySensorTypes.MOISTURE, {
        characteristic: LeakDetected,
        service: LeakSensor,
    }],
]);

export const binarySensorHelper = (component: BinarySensorComponent, accessory: HomebridgePlatformAccessory): boolean => {

    const homekitStuff = map.get(component.deviceClass);

    if (homekitStuff) {
        const ServiceConstructor = homekitStuff?.service;
        let service = accessory.services.find((service) => service.UUID === ServiceConstructor.UUID);
        if (!service) {
            service = accessory.addService(new ServiceConstructor(component.name, ''));
        }

        service.getCharacteristic(homekitStuff.characteristic)
            ?.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                callback(null, component.status);
            });

        component.state$.pipe(
            tap(() => {
                service?.getCharacteristic(homekitStuff.characteristic)?.setValue(component.status);
            }),
        ).subscribe();
        return true;
    }
    return false;
};
