import { tap } from 'rxjs/operators';
import { Characteristic, Service } from '../index';
import { SensorComponent } from 'esphome-ts';
import { CharacteristicValue, PlatformAccessory, Service as HAPService } from 'homebridge';

const isTemperatureComponent = (unitOfMeasurement: unknown) => unitOfMeasurement === '°C' || unitOfMeasurement === '°F';

export const sensorHelper = (component: SensorComponent, accessory: PlatformAccessory): boolean => {
    if (isTemperatureComponent(component.unitOfMeasurement)) {
        defaultSetup(component, accessory, Service.TemperatureSensor, Characteristic.CurrentTemperature);
        return true;
    } else if (
        component.unitOfMeasurement === '%' &&
        (component.icon === 'mdi:water-percent' || component.deviceClass === 'humidity')
    ) {
        defaultSetup(component, accessory, Service.HumiditySensor, Characteristic.CurrentRelativeHumidity);
        return true;
    } else if (component.unitOfMeasurement === 'µg/m³') {
        // && component.icon === 'mdi:air-filter'
        defaultSetup(component, accessory, Service.AirQualitySensor, Characteristic.PM2_5Density);
        return true;
    }
    return false;
};

const defaultSetup = (
    component: SensorComponent,
    accessory: PlatformAccessory,
    SelectedService: typeof Service.TemperatureSensor | typeof Service.HumiditySensor | typeof Service.AirQualitySensor,
    SelectedCharacteristic:
        | typeof Characteristic.CurrentTemperature
        | typeof Characteristic.CurrentRelativeHumidity
        | typeof Characteristic.PM2_5Density,
): void => {
    let targetSensor: HAPService | undefined = accessory.services.find(
        (service) => service.UUID === SelectedService.UUID,
    );
    if (!targetSensor) {
        targetSensor = accessory.addService(new SelectedService(component.name, ''));
    }

    component.state$
        .pipe(
            // @ts-ignore
            tap(() =>
                targetSensor
                    ?.getCharacteristic(SelectedCharacteristic)
                    ?.setValue(component.value! as CharacteristicValue),
            ),
        )
        .subscribe();
};
