import { Characteristic, Service } from '../index';
import { ClimateMode, ClimateState } from '../state/climateState';
import {
    PlatformAccessory,
    Service as HAPService,
    Formats,
    CharacteristicEventTypes,
    CharacteristicValue,
    CharacteristicSetCallback,
} from 'homebridge';

function mapHeaterCoolerState(i: ClimateMode) {
    switch (i) {
        case ClimateMode.AUTO:
            return Characteristic.TargetHeaterCoolerState.AUTO;
        case ClimateMode.COOL:
            return Characteristic.TargetHeaterCoolerState.COOL;
        case ClimateMode.HEAT:
            return Characteristic.TargetHeaterCoolerState.HEAT;
        case ClimateMode.OFF:
            return 0;
        case ClimateMode.FAN_ONLY:
        case ClimateMode.DRY:
        default:
            return -1;
    }
}

function currentHeaterCoolerState(i: number) {
    switch (i) {
        case Characteristic.TargetHeaterCoolerState.AUTO:
            return Characteristic.CurrentHeaterCoolerState.HEATING;
        case Characteristic.TargetHeaterCoolerState.COOL:
            return Characteristic.CurrentHeaterCoolerState.COOLING;
        case Characteristic.TargetHeaterCoolerState.HEAT:
            return Characteristic.CurrentHeaterCoolerState.HEATING;
        case 0:
        default:
            return Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }
}

function reverseMapHeaterCoolerState(i: number) {
    switch (i) {
        case Characteristic.TargetHeaterCoolerState.AUTO:
            return ClimateMode.AUTO;
        case Characteristic.TargetHeaterCoolerState.COOL:
            return ClimateMode.COOL;
        case Characteristic.TargetHeaterCoolerState.HEAT:
            return ClimateMode.HEAT;
        case 0:
        default:
            return ClimateMode.OFF;
    }
}

export const climateHelper = (component: any, accessory: PlatformAccessory): boolean => {
    let service: HAPService | undefined = accessory.services.find(
        (service: HAPService) => service.UUID === Service.HeaterCooler.UUID,
    );
    if (!service) {
        service = accessory.addService(new Service.HeaterCooler(component.name, ''));
    }

    if (!service) {
        return false;
    }

    // function logIfDebug(msg?: any, ...parameters: unknown[]): void {
    //     if (debug) {
    //         log(msg, parameters);
    //     } else {
    //         log.debug(msg, parameters);
    //     }
    // }

    const supportedModesList = component.config.supportedModesList as number[];
    const supportedFanModesList = component.config.supportedFanModesList as number[];
    const supportedSwingModesList = component.config.supportedSwingModesList as number[];

    const climateState: ClimateState = new ClimateState(component.connection, component.id);

    climateState.supportTwoPointTargetTemperature = component.config.supportsTwoPointTargetTemperature;

    service
        .getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .setProps({
            minValue: component.config.visualMinTemperature,
            maxValue: component.config.visualMaxTemperature,
            minStep: 1,
        })
        .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            // logIfDebug('CoolingThresholdTemperature', state);
            const temperature = state as number;

            if (climateState.supportTwoPointTargetTemperature) {
                climateState.targetTemperatureLow = temperature;
            } else {
                climateState.targetTemperature = temperature;
            }
            climateState.updateEsp();
        });

    service
        .getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .setProps({
            minValue: component.config.visualMinTemperature,
            maxValue: component.config.visualMaxTemperature,
            minStep: 1,
        })
        .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            // logIfDebug('HeatingThresholdTemperature', state);
            const temperature = state as number;

            if (climateState.supportTwoPointTargetTemperature) {
                climateState.targetTemperatureHigh = temperature;
            } else {
                climateState.targetTemperature = temperature;
            }
            climateState.updateEsp();
        });

    service
        ?.getCharacteristic(Characteristic.Active)
        .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            // logIfDebug('Active', state);
            climateState.active = (state as number) === 1;
            climateState.updateEsp();
            callback();
        });

    // 0 = off, 1 = auto, 2 = cool, 3 = heat, 4 = fan_only, 5 = dry
    if (supportedModesList.length > 0) {
        const targetHeaterCoolerStateList: number[] = [];
        supportedModesList.forEach(function (i) {
            const mapped = mapHeaterCoolerState(i);
            if (mapped !== -1 && targetHeaterCoolerStateList.indexOf(mapped) === -1) {
                targetHeaterCoolerStateList.push(mapped);
            }
        });

        service
            .getCharacteristic(Characteristic.TargetHeaterCoolerState)
            .setProps({
                unit: null,
                format: Formats.UINT8,
                maxValue: Math.max(...targetHeaterCoolerStateList),
                minValue: Math.min(...targetHeaterCoolerStateList),
                validValues: targetHeaterCoolerStateList,
            })
            .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
                // logIfDebug('TargetHeaterCoolerState', state);
                if (typeof state === 'number') {
                    climateState.climateMode = reverseMapHeaterCoolerState(state);
                    climateState.updateEsp();
                }
                callback();
            });
    }

    if (supportedFanModesList.length > 0) {
        service
            .getCharacteristic(Characteristic.CurrentFanState)
            .setProps({
                unit: null,
                format: Formats.UINT8,
                maxValue: Math.max(...supportedFanModesList),
                minValue: Math.min(...supportedFanModesList),
                validValues: supportedFanModesList,
            })
            .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
                // logIfDebug('CurrentFanState', state);
                if (typeof state === 'number') {
                    climateState.fanMode = state;
                    climateState.updateEsp();
                }
                callback();
            });
    }

    // 0 == off, 1 == both, 2 == vertical, 3 == horizontal
    if (supportedSwingModesList.length > 0) {
        service
            .getCharacteristic(Characteristic.RotationDirection)
            .setProps({
                unit: null,
                format: Formats.UINT8,
                maxValue: Math.max(...supportedSwingModesList),
                minValue: Math.min(...supportedSwingModesList),
                validValues: supportedSwingModesList,
            })
            .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
                // logIfDebug('RotationDirection', state);
                if (typeof state === 'number') {
                    climateState.swingMode = state;
                    climateState.updateEsp();
                }
                callback();
            });
    }

    service
        .getCharacteristic(Characteristic.TargetTemperature)
        .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            // logIfDebug('TargetTemperature', state);
            if (typeof state === 'number') {
                climateState.targetTemperature = state;
                climateState.updateEsp();
            }
            callback();
        });

    component.on('state', (state: any) => {
        climateState.active = (state.mode as ClimateMode) !== ClimateMode.OFF;
        climateState.targetTemperature = state.targetTemperature;
        climateState.targetTemperatureLow = state.targetTemperatureLow;
        climateState.targetTemperatureHigh = state.targetTemperatureHigh;
        climateState.climateMode = state.mode;

        service?.getCharacteristic(Characteristic.Active)?.updateValue(climateState.active);

        if (component.config.supportsCurrentTemperature) {
            climateState.currentTemperature = state.currentTemperature;
            service?.getCharacteristic(Characteristic.CurrentTemperature)?.updateValue(climateState.currentTemperature);
        }
        service?.getCharacteristic(Characteristic.TargetTemperature)?.updateValue(climateState.targetTemperature);

        const targetTemperatureLow = climateState.supportTwoPointTargetTemperature
            ? climateState.targetTemperatureLow
            : climateState.targetTemperature;
        const targetTemperatureHigh = climateState.supportTwoPointTargetTemperature
            ? climateState.targetTemperatureHigh
            : climateState.targetTemperature;

        service?.getCharacteristic(Characteristic.CoolingThresholdTemperature)?.updateValue(targetTemperatureLow);
        service?.getCharacteristic(Characteristic.HeatingThresholdTemperature)?.updateValue(targetTemperatureHigh);

        if (supportedModesList.length > 0) {
            const targetHeaterCoolerState = mapHeaterCoolerState(climateState.climateMode);

            service?.getCharacteristic(Characteristic.TargetHeaterCoolerState)?.updateValue(targetHeaterCoolerState);
            service
                ?.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
                ?.updateValue(currentHeaterCoolerState(targetHeaterCoolerState));
        }

        if (supportedFanModesList.length > 0) {
            climateState.fanMode = state.fanMode;
            service?.getCharacteristic(Characteristic.CurrentFanState)?.updateValue(climateState.fanMode);
        }

        if (supportedSwingModesList.length > 0) {
            climateState.swingMode = state.swingMode;
            service?.getCharacteristic(Characteristic.RotationDirection)?.updateValue(climateState.swingMode);
        }
    });

    return true;
};
