import {CharacteristicEventTypes, CharacteristicGetCallback} from 'hap-nodejs';
import {tap} from 'rxjs/operators';
import {BinarySensorComponent} from 'esphome-ts/dist';
import {BinarySensorTypes} from 'esphome-ts/dist/components/binarySensorTypes';
import {PlatformAccessory} from 'homebridge';
import {Characteristic, Service} from '../index';

type SupportedServices = typeof Service.MotionSensor
    | typeof Service.LeakSensor
    | typeof Service.ContactSensor
    | typeof Service.SmokeSensor;
type SupportedCharacteristics =
    typeof Characteristic.MotionDetected
    | typeof Characteristic.ContactSensorState
    | typeof Characteristic.SmokeDetected
    | typeof Characteristic.LeakDetected;

interface BinarySensorHomekit {
    characteristic: SupportedCharacteristics,
    service: SupportedServices;
}

const map = (): Map<BinarySensorTypes, BinarySensorHomekit> => {
    return new Map<BinarySensorTypes, BinarySensorHomekit>([
        [BinarySensorTypes.MOTION, {
            characteristic: Characteristic.MotionDetected,
            service: Service.MotionSensor,
        }],
        [BinarySensorTypes.WINDOW, {
            characteristic: Characteristic.ContactSensorState,
            service: Service.ContactSensor,
        }],
        [BinarySensorTypes.DOOR, {
            characteristic: Characteristic.ContactSensorState,
            service: Service.ContactSensor,
        }],
        [BinarySensorTypes.SMOKE, {
            characteristic: Characteristic.SmokeDetected,
            service: Service.SmokeSensor,
        }],
        [BinarySensorTypes.MOISTURE, {
            characteristic: Characteristic.LeakDetected,
            service: Service.LeakSensor,
        }],
    ]);
};

export const binarySensorHelper = (component: BinarySensorComponent, accessory: PlatformAccessory): boolean => {

    const homekitStuff = map().get(component.deviceClass);

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
