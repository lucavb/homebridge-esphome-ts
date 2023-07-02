import { Characteristic, Service } from '../index';
import {
    PlatformAccessory,
    Service as HAPService,
    Formats,
    CharacteristicEventTypes,
    CharacteristicValue,
    CharacteristicSetCallback,
} from 'homebridge';

enum ClimateMode {
    OFF = 0,
    AUTO = 1, // => Characteristic.TargetHeaterCoolerState.AUTO
    COOL = 2, // => Characteristic.TargetHeaterCoolerState.COOL
    HEAT = 3, // => Characteristic.TargetHeaterCoolerState.HEAT
    FAN_ONLY = 4,
    DRY = 5,
}

enum ClimateFanState {
    ON = 0,
    OFF = 1,
    AUTO = 2,
    LOW = 3,
    MEDIUM = 4,
    HIGH = 5,
    MIDDLE = 6,
    FOCUS = 7,
    DIFFUSED = 8,
    QUIET = 9,
}

function mapHeaterCoolerState(i: number) {
    switch (i) {
        case ClimateMode.AUTO:
            return Characteristic.TargetHeaterCoolerState.AUTO;
        case ClimateMode.COOL:
            return Characteristic.TargetHeaterCoolerState.COOL;
        case ClimateMode.HEAT:
            return Characteristic.TargetHeaterCoolerState.HEAT;
        case ClimateMode.OFF:
        default:
            return 0;
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
    const date = new Date();

    let previousModeState: ClimateMode = 0;
    let targetTemperatureLow: number = 0;
    let targetTemperatureHigh: number = 0;
    let temperatureLastChanged: number = date.getTime();
    const supportedModesList = component.config.supportedModesList as number[];
    const supportedFanModesList = component.config.supportedFanModesList as number[];
    const supportedSwingModesList = component.config.supportedSwingModesList as number[];

    service
        .getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .setValue(component.config.visualMinTemperature)
        .setProps({
            // minValue: component.config.visualMinTemperature,
            // maxValue: component.config.visualMaxTemperature,
            minStep: 1,
        })
        .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            targetTemperatureLow = state as number;

            setHeatCoolAuto(targetTemperatureLow, ClimateMode.COOL);

            callback();
        });


    function setHeatCoolAuto(targetTemperature: number, mode: ClimateMode) {

        // 2 events will be received, so we need to capture both to set the mode to AUTO
        if (date.getTime() - temperatureLastChanged < 50) {
            component.connection.climateCommandService({
                key: component.id,
                targetTemperatureLow: targetTemperatureLow,
                targetTemperatureHigh: targetTemperatureHigh,
                targetTemperature: targetTemperature,
                mode: ClimateMode.AUTO,
            });
        } else {
            component.connection.climateCommandService({
                key: component.id,
                targetTemperatureLow: targetTemperature,
                targetTemperatureHigh: targetTemperature,
                targetTemperature: targetTemperature,
                mode: mode,
            });
        }
        temperatureLastChanged = date.getTime();
    }
        

    service
        .getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .setValue(component.config.visualMinTemperature)
        .setProps({
            // minValue: component.config.visualMinTemperature,
            // maxValue: component.config.visualMaxTemperature,
            minStep: 1,
        })
        .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            targetTemperatureHigh = state as number;

            setHeatCoolAuto(targetTemperatureHigh, ClimateMode.HEAT);

            callback();
        });

    service
        ?.getCharacteristic(Characteristic.Active)
        .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            // set back to the previous state if turned on, or default to AUTO if we have no known previous state
            const mode = (state as number) === 1 ? previousModeState : ClimateMode.OFF;
            if ((state as number) === 1 && mode === ClimateMode.OFF) {
                state = ClimateMode.AUTO;
            }

            component.connection.climateCommandService({
                key: component.id,
                mode: mode,
            });
            callback();
        });

    // 0 = off, 1 = auto, 2 = cool, 3 = heat, 4 = fan_only, 5 = dry
    if (supportedModesList.length > 0) {
        const targetHeaterCoolerStateList: number[] = [];
        supportedModesList.forEach(function (i) {
            targetHeaterCoolerStateList.push(mapHeaterCoolerState(i));
        });

        service
            .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
            .setValue(Math.min(...targetHeaterCoolerStateList))
            .setProps({
                unit: null,
                format: Formats.UINT8,
                maxValue: Math.max(...targetHeaterCoolerStateList),
                minValue: Math.min(...targetHeaterCoolerStateList),
                validValues: targetHeaterCoolerStateList,
            })
            .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
                if (typeof state === 'number') {
                    component.connection.climateCommandService({
                        key: component.id,
                        mode: state,
                    });
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
                if (typeof state === 'number') {
                    component.connection.climateCommandService({
                        key: component.id,
                        fanMode: state,
                    });
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
                if (typeof state === 'number') {
                    component.connection.climateCommandService({
                        key: component.id,
                        swingMode: state,
                    });
                }
                callback();
            });
    }

    service
        .getCharacteristic(Characteristic.TargetTemperature)
        .on(CharacteristicEventTypes.SET, (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
            if (typeof state === 'number') {
                component.connection.climateCommandService({
                    key: component.id,
                    targetTemperature: state,
                });
            }
            callback();
        });

    component.on('state', (state: any) => {
        // preserve the previous mode state so that it can be used to turn back on.
        if ((state.mode as ClimateMode) !== ClimateMode.OFF) {
            previousModeState = state.mode;
        }

        service?.getCharacteristic(Characteristic.Active)?.updateValue(state.mode !== 0);

        if (component.config.supportsCurrentTemperature) {
            service?.getCharacteristic(Characteristic.CurrentTemperature)?.updateValue(state.currentTemperature);
        }
        service?.getCharacteristic(Characteristic.TargetTemperature)?.updateValue(state.targetTemperature);
        service?.getCharacteristic(Characteristic.CoolingThresholdTemperature)?.updateValue(state.targetTemperatureLow);
        service
            ?.getCharacteristic(Characteristic.HeatingThresholdTemperature)
            ?.updateValue(state.targetTemperatureHigh);

        if (supportedModesList.length > 0) {
            service
                ?.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
                ?.updateValue(mapHeaterCoolerState(state.mode));
        }

        if (supportedFanModesList.length > 0) {
            service?.getCharacteristic(Characteristic.CurrentFanState)?.updateValue(state.fanMode);
        }

        if (supportedSwingModesList.length > 0) {
            service?.getCharacteristic(Characteristic.RotationDirection)?.updateValue(state.swingMode);
        }
    });

    return true;
};

