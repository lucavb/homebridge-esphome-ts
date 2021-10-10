import { FanComponent } from 'esphome-ts';
import {
    CharacteristicEventTypes,
    CharacteristicSetCallback,
    CharacteristicValue,
    PlatformAccessory,
} from 'homebridge';
import { Characteristic, Service } from '../index';
import { tap } from 'rxjs/operators';
import { FanDirection, FanSpeed } from 'esphome-ts/dist/api/protobuf/api';

const fanSpeedMapping = [
    {
        homekit: 0,
    },
    {
        homekit: 33,
        esp: FanSpeed.FAN_SPEED_LOW,
    },

    {
        homekit: 66,
        esp: FanSpeed.FAN_SPEED_MEDIUM,
    },
    {
        homekit: 100,
        esp: FanSpeed.FAN_SPEED_HIGH,
    },
];

const getEspSpeed = (homekitSpeed: number): FanSpeed | undefined =>
    fanSpeedMapping.reduce((prev, curr) =>
        Math.abs(curr.homekit - homekitSpeed) < Math.abs(prev.homekit - homekitSpeed) ? curr : prev,
    ).esp;

const getHomekitSpeed = (fanSpeed: FanSpeed): number =>
    fanSpeedMapping.find(({ esp }) => esp === fanSpeed)?.homekit ?? 0;

export const fanHelper = (component: FanComponent, accessory: PlatformAccessory): boolean => {
    let fanService = accessory.services.find((service) => service.UUID === Service.Fanv2.UUID);
    if (!fanService) {
        fanService = accessory.addService(new Service.Fanv2(component.name, ''));
    }

    if (component.supportsSpeed) {
        fanService
            .getCharacteristic(Characteristic.RotationSpeed)
            ?.on(
                CharacteristicEventTypes.SET,
                (rotationSpeed: CharacteristicValue, callback: CharacteristicSetCallback) => {
                    if (typeof rotationSpeed === 'number') {
                        const espSpeed = getEspSpeed(rotationSpeed);
                        if (espSpeed !== undefined) {
                            component.setSpeed(espSpeed);
                        }
                    }
                    callback();
                },
            );
    }

    if (component.supportsDirection) {
        fanService
            .getCharacteristic(Characteristic.RotationDirection)
            ?.on(
                CharacteristicEventTypes.SET,
                (rotationDirection: CharacteristicValue, callback: CharacteristicSetCallback): void => {
                    component.setDirection(
                        Characteristic.RotationDirection.CLOCKWISE === rotationDirection
                            ? FanDirection.FAN_DIRECTION_FORWARD
                            : FanDirection.FAN_DIRECTION_REVERSE,
                    );
                    callback();
                },
            );
    }

    component.state$
        .pipe(
            tap((state): void => {
                fanService?.getCharacteristic(Characteristic.On)?.setValue(!!state.state);
                if (component.supportsSpeed && state.speed !== undefined) {
                    fanService?.getCharacteristic(Characteristic.RotationSpeed)?.setValue(getHomekitSpeed(state.speed));
                }
                if (component.supportsDirection && state.direction !== undefined) {
                    fanService
                        ?.getCharacteristic(Characteristic.RotationDirection)
                        ?.setValue(
                            state.direction === FanDirection.FAN_DIRECTION_FORWARD
                                ? Characteristic.RotationDirection.CLOCKWISE
                                : Characteristic.RotationDirection.COUNTER_CLOCKWISE,
                        );
                }
            }),
        )
        .subscribe();

    fanService
        .getCharacteristic(Characteristic.On)
        ?.on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
            value ? component.turnOn() : component.turnOff();
            callback();
        });

    return true;
};
