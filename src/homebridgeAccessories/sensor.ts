import { Characteristic, Service } from '../index';
import { PlatformAccessory, Service as HAPService } from 'homebridge';

const fahrenheitUnit = '°F';

const isTemperatureComponent = (unitOfMeasurement: unknown) =>
    unitOfMeasurement === '°C' || unitOfMeasurement === fahrenheitUnit;

const fahrenheitToCelsius = (fahrenheit: number): number => ((fahrenheit - 32) * 5) / 9;

export const sensorHelper = (component: any, accessory: PlatformAccessory): boolean => {
    if (isTemperatureComponent(component.config.unitOfMeasurement)) {
        defaultSetup(component, accessory, Service.TemperatureSensor, Characteristic.CurrentTemperature);
        return true;
    } else if (
        component.config.unitOfMeasurement === '%' &&
        (component.config.icon === 'mdi:water-percent' || component.config.deviceClass === 'humidity')
    ) {
        defaultSetup(component, accessory, Service.HumiditySensor, Characteristic.CurrentRelativeHumidity);
        return true;
    }
    return false;
};

const defaultSetup = (
    component: any,
    accessory: PlatformAccessory,
    SelectedService: typeof Service.TemperatureSensor | typeof Service.HumiditySensor,
    SelectedCharacteristic: typeof Characteristic.CurrentTemperature | typeof Characteristic.CurrentRelativeHumidity,
): void => {
    let temperatureSensor: HAPService | undefined = accessory.services.find(
        (service) => service.UUID === SelectedService.UUID,
    );
    if (!temperatureSensor) {
        temperatureSensor = accessory.addService(new SelectedService(component.name, ''));
    }
    const valuesAreFahrenheit = component.config.unitOfMeasurement === fahrenheitUnit;

    component.on('state', (state: any) => {
        const celsiusValue =
            valuesAreFahrenheit && state.state !== undefined ? fahrenheitToCelsius(state.state) : state.state;
        temperatureSensor?.getCharacteristic(SelectedCharacteristic)?.setValue(celsiusValue!);
    });
};
