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
        default:
            return -1;
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

    const supportedModesList = component.config.supportedModesList as number[];
    const supportedFanModesList = component.config.supportedFanModesList as number[];
    const supportedSwingModesList = component.config.supportedSwingModesList as number[];

    const climateState: ClimateState = new ClimateState(component.connection, component.id);

    climateState.supportTwoPointTargetTemperature = component.config.supportsTwoPointTargetTemperature;

    service
        .getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .setValue(component.config.visualMinTemperature)
        .setProps({
            minValue: component.config.visualMinTemperature,
            maxValue: component.config.visualMaxTemperature,
            minStep: 1,
        })
        .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            console.log('CoolingThresholdTemperature', state);
            climateState.targetTemperatureLow = state as number;
            setTimeout(() => {
                climateState.updateEsp();
            }, 100);
            callback();
        });

    service
        .getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .setValue(component.config.visualMinTemperature)
        .setProps({
            minValue: component.config.visualMinTemperature,
            maxValue: component.config.visualMaxTemperature,
            minStep: 1,
        })
        .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            console.log('HeatingThresholdTemperature', state);
            climateState.targetTemperatureHigh = state as number;
            setTimeout(() => {
                climateState.updateEsp();
            }, 100);
            callback();
        });

    service
        ?.getCharacteristic(Characteristic.Active)
        .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            console.log('Active', state);
            climateState.active = (state as number) === 1;
            setTimeout(() => {
                climateState.updateEsp();
            }, 100);
            callback();
        });

    // 0 = off, 1 = auto, 2 = cool, 3 = heat, 4 = fan_only, 5 = dry
    if (supportedModesList.length > 0) {
        const targetHeaterCoolerStateList: number[] = [];
        supportedModesList.forEach(function (i) {
            var mapped = mapHeaterCoolerState(i);
            if(mapped != -1) targetHeaterCoolerStateList.push(mapped);
        });

        console.debug("CurrentHeaterCoolerState", targetHeaterCoolerStateList);
        service
            .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
            .setValue(Math.min(...targetHeaterCoolerStateList))
            .setProps({
                unit: null,
                format: Formats.UINT8,
                // maxValue: Math.max(...targetHeaterCoolerStateList),
                // minValue: Math.min(...targetHeaterCoolerStateList),
                // validValues: targetHeaterCoolerStateList,
            })
            .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
                console.log('CurrentHeaterCoolerState', state);
                if (typeof state === 'number') {
                    console.log('set', state, reverseMapHeaterCoolerState(state));
                    climateState.climateMode = reverseMapHeaterCoolerState(state);
                    setTimeout(() => {
                        climateState.updateEsp();
                    }, 100);
                }
                callback();
            });
    }

    if (supportedFanModesList.length > 0) {
        service
            .getCharacteristic(Characteristic.CurrentFanState)
            .setValue(Math.min(...supportedFanModesList))
            .setProps({
                unit: null,
                format: Formats.UINT8,
                maxValue: Math.max(...supportedFanModesList),
                minValue: Math.min(...supportedFanModesList),
                validValues: supportedFanModesList,
            })
            .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
                console.log('CurrentFanState', state);
                if (typeof state === 'number') {
                    climateState.fanMode = state;
                    setTimeout(() => {
                        climateState.updateEsp();
                    }, 100);
                }
                callback();
            });
    }

    // 0 == off, 1 == both, 2 == vertical, 3 == horizontal
    if (supportedSwingModesList.length > 0) {
        service
            .getCharacteristic(Characteristic.RotationDirection)
            .setValue(Math.min(...supportedSwingModesList))
            .setProps({
                unit: null,
                format: Formats.UINT8,
                maxValue: Math.max(...supportedSwingModesList),
                minValue: Math.min(...supportedSwingModesList),
                validValues: supportedSwingModesList,
            })
            .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
                console.log('RotationDirection', state);
                if (typeof state === 'number') {
                    climateState.swingMode = state;
                    setTimeout(() => {
                        climateState.updateEsp();
                    }, 100);
                }
                callback();
            });
    }

    service
        .getCharacteristic(Characteristic.TargetTemperature)
        .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            console.log('TargetTemperature', state);
            if (typeof state === 'number') {
                climateState.targetTemperature = state;
                setTimeout(() => {
                    climateState.updateEsp();
                }, 100);
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
        service
            ?.getCharacteristic(Characteristic.CoolingThresholdTemperature)
            ?.updateValue(climateState.targetTemperatureLow);
        service
            ?.getCharacteristic(Characteristic.HeatingThresholdTemperature)
            ?.updateValue(climateState.targetTemperatureHigh);

        if (supportedModesList.length > 0) {
            climateState.climateMode = state.Mode;
            service
                ?.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
                ?.updateValue(mapHeaterCoolerState(climateState.climateMode));
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
