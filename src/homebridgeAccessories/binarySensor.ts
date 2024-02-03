import { CharacteristicEventTypes, CharacteristicGetCallback } from 'hap-nodejs';
import { Characteristic, Service } from '../index';
import { PlatformAccessory } from 'homebridge';

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

const map = (): Map<string, BinarySensorHomekit> => {
    return new Map<string, BinarySensorHomekit>([
        [
            'motion',
            {
                characteristic: Characteristic.MotionDetected,
                service: Service.MotionSensor,
            },
        ],
        [
            'window',
            {
                characteristic: Characteristic.ContactSensorState,
                service: Service.ContactSensor,
            },
        ],
        [
            'door',
            {
                characteristic: Characteristic.ContactSensorState,
                service: Service.ContactSensor,
            },
        ],
        [
            'smoke',
            {
                characteristic: Characteristic.SmokeDetected,
                service: Service.SmokeSensor,
            },
        ],
        [
            'moisture',
            {
                characteristic: Characteristic.LeakDetected,
                service: Service.LeakSensor,
            },
        ],
        [
            'garage_door',
            {
                characteristic: Characteristic.ContactSensorState,
                service: Service.ContactSensor,
            },
        ],
        // TODO: Figure out which ones make sense
        // [
        //     "connectivity",
        //     {
        //         characteristic: ,
        //         service: ,
        //     },
        // ],

        [
            '',
            {
                characteristic: Characteristic.On,
                service: Service.Switch,
            },
        ],
    ]);
};

export const binarySensorHelper = (component: any, accessory: PlatformAccessory): boolean => {
    const homekitDevice = map().get(component.config.deviceClass as string);

    if (homekitDevice && !((component?.config?.isStatusBinarySensor as boolean) ?? false)) {
        const ServiceConstructor = homekitDevice?.service;
        let service = accessory.services.find((service) => service.UUID === ServiceConstructor.UUID);
        if (!service) {
            service = accessory.addService(new ServiceConstructor(component.name, ''));
        }

        let currentState = false;

        service
            .getCharacteristic(homekitDevice.characteristic)
            ?.on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
                if (component.status !== !!currentState) {
                    currentState = component.status;
                    updateEsp();
                }

                callback();
            });

        component.on('state', (state: any) => {
            currentState = state.state;

            service?.getCharacteristic(homekitDevice.characteristic)?.updateValue(state.state);
        });

        function updateEsp() {
            const state = {
                key: component.id,
                state: currentState,
            };

            component.connection.lightCommandService(state);
        }

        return true;
    }

    return false;
};
