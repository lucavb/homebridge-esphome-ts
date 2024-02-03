import { CharacteristicEventTypes } from 'hap-nodejs';
import { Characteristic, Service } from '../index';
import { CharacteristicSetCallback, CharacteristicValue, PlatformAccessory } from 'homebridge';

type SupportedServices = typeof Service.Door | typeof Service.GarageDoorOpener | typeof Service.WindowCovering;

const map = (): Map<string, SupportedServices> => {
    return new Map<string, SupportedServices>([
        ['garage', Service.Door],
        ['curtain', Service.WindowCovering],
        ['window', Service.WindowCovering],
        ['blind', Service.WindowCovering],
    ]);
};

enum EspHomeCoverOperation {
    IDLE = 0,
    OPENING = 1,
    CLOSING = 2,
}

enum HomePositionState {
    IDLE = 0,
    OPENING = 1,
    CLOSING = 2,
}

export const coverHelper = (component: any, accessory: PlatformAccessory): boolean => {
    const ServiceConstructor = map().get(component.config.deviceClass as string) as SupportedServices;

    let service = accessory.services.find((service) => service.UUID === ServiceConstructor.UUID);
    if (!service) {
        service = accessory.addService(new ServiceConstructor(component.config.name, ''));
    }

    const assumedState = component.config.assumedState as boolean;
    const supportsPosition = component.config.supportsPosition as boolean;
    const supportsTilt = component.config.supportsTilt as boolean;
    const supportsStop = component.config.supportsStop as boolean;

    let currentPosition = 0;
    let currentTilt = 0;

    if (supportsPosition) {
        service
            .getCharacteristic(Characteristic.TargetPosition)
            ?.on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                if (currentPosition !== (value as number)) {
                    currentPosition = value as number;
                    updateEsp();
                }
                callback();
            });
    } else {
        service
            .getCharacteristic(Characteristic.TargetPosition)
            .setProps({
                validValues: [0, 100],
            })
            ?.on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                if (currentPosition !== (value as number)) {
                    currentPosition = value as number;
                    updateEsp();
                }
                callback();
            });
    }
    if (supportsTilt) {
        service
            .getCharacteristic(Characteristic.TargetTiltAngle)
            ?.on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
                if (currentTilt !== (value as number)) {
                    currentTilt = value as number;
                    updateEsp();
                }
                callback();
            });
    }

    component.on('state', (state: any) => {
        const isClosed = state.legacyState as boolean;

        if (supportsPosition) {
            currentPosition = (state.position as number) * 100; // state.position is between 0.0 and 1.0
        } else {
            currentPosition = isClosed ? 0 : 100; // 0 is open 1 is closed
            service?.getCharacteristic(Characteristic.TargetPosition).updateValue(currentPosition);
        }

        service?.getCharacteristic(Characteristic.CurrentPosition).updateValue(currentPosition);

        if (supportsTilt) {
            currentTilt = (state.tilt as number) * 180; // state.position is between 0.0 and 1.0;
            service?.getCharacteristic(Characteristic.CurrentTiltAngle).updateValue(currentTilt);
        }

        if (supportsPosition) {
            let positionState: HomePositionState;

            switch (state.currentOperation as EspHomeCoverOperation) {
                case EspHomeCoverOperation.IDLE:
                    positionState = HomePositionState.IDLE;
                    break;
                case EspHomeCoverOperation.OPENING:
                    positionState = HomePositionState.OPENING;
                    break;
                case EspHomeCoverOperation.CLOSING:
                default:
                    positionState = HomePositionState.CLOSING;
                    break;
            }

            service?.getCharacteristic(Characteristic.PositionState).updateValue(positionState);
        }
    });

    function updateEsp() {
        if (supportsPosition) {
            const state = {
                key: component.id,
                position: currentPosition / 100,
                tilt: currentTilt / 180,
            };

            component.connection.coverCommandService(state);
        } else {
            const legacyCommand = currentPosition > 99 ? 0 : 1;

            const state = {
                key: component.id,
                legacyCommand: legacyCommand,
                tilt: currentTilt / 180,
            };

            component.connection.coverCommandService(state);
        }
    }

    return true;
};
