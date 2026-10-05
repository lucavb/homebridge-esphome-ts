import type { API, Characteristic, PlatformAccessory, Service } from 'homebridge';
import { SensorComponent } from 'esphome-ts';
import type { BaseComponent } from 'esphome-ts';

import { bindComponent } from './componentBinding.js';

const fahrenheitUnit = '°F';

const isTemperatureComponent = (unitOfMeasurement: unknown) =>
    unitOfMeasurement === '°C' || unitOfMeasurement === fahrenheitUnit;

const fahrenheitToCelsius = (fahrenheit: number): number => ((fahrenheit - 32) * 5) / 9;

/** Valid range of the HomeKit CurrentAmbientLightLevel characteristic. */
const MIN_AMBIENT_LIGHT_LUX = 0.0001;
const MAX_AMBIENT_LIGHT_LUX = 100_000;

interface ValueClamp {
    min: number;
    max: number;
}

const clampTo = (value: number, clamp: ValueClamp): number => Math.max(clamp.min, Math.min(clamp.max, value));

type SelectedServiceType =
    typeof Service.TemperatureSensor | typeof Service.HumiditySensor | typeof Service.LightSensor;
type SelectedCharacteristicType =
    | typeof Characteristic.CurrentTemperature
    | typeof Characteristic.CurrentRelativeHumidity
    | typeof Characteristic.CurrentAmbientLightLevel;

export const sensorHelper = (
    component: BaseComponent,
    accessory: PlatformAccessory,
    api: API,
): (() => void) | undefined => {
    if (!(component instanceof SensorComponent)) {
        return undefined;
    }
    const { Characteristic: CharacteristicClass, Service: ServiceClass } = api.hap;
    if (isTemperatureComponent(component.unitOfMeasurement)) {
        return setupRow(
            component,
            accessory,
            api,
            ServiceClass.TemperatureSensor,
            CharacteristicClass.CurrentTemperature,
        );
    } else if (
        component.unitOfMeasurement === '%' &&
        (component.icon === 'mdi:water-percent' || component.deviceClass === 'humidity')
    ) {
        return setupRow(
            component,
            accessory,
            api,
            ServiceClass.HumiditySensor,
            CharacteristicClass.CurrentRelativeHumidity,
        );
    } else if (component.unitOfMeasurement === 'lx' || component.deviceClass === 'illuminance') {
        return setupRow(
            component,
            accessory,
            api,
            ServiceClass.LightSensor,
            CharacteristicClass.CurrentAmbientLightLevel,
            {
                min: MIN_AMBIENT_LIGHT_LUX,
                max: MAX_AMBIENT_LIGHT_LUX,
            },
        );
    }
    return undefined;
};

const setupRow = (
    component: SensorComponent,
    accessory: PlatformAccessory,
    api: API,
    SelectedService: SelectedServiceType,
    SelectedCharacteristic: SelectedCharacteristicType,
    clamp?: ValueClamp,
): (() => void) => {
    const valuesAreFahrenheit = component.unitOfMeasurement === fahrenheitUnit;

    return bindComponent(component, accessory, api, [
        {
            service: SelectedService,
            name: component.name,
            characteristic: SelectedCharacteristic,
            project: () => {
                const convertedValue =
                    valuesAreFahrenheit && component.value !== undefined
                        ? fahrenheitToCelsius(component.value)
                        : component.value;
                if (convertedValue === undefined) {
                    // No measurement yet; silently skip so a throw cannot kill the state$ subscription.
                    return undefined;
                }
                return clamp === undefined ? convertedValue : clampTo(convertedValue, clamp);
            },
        },
    ]);
};
