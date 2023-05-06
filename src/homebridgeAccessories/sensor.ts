import { SensorComponent } from 'esphome-ts';
import { CharacteristicValue, PlatformAccessory, Service as HAPService } from 'homebridge';
import { tap } from 'rxjs/operators';
import { Characteristic, Service } from '../index';

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
        airQualitySetup(component, accessory);
        return true;
    }
    return false;
};

const defaultSetup = (
    component: SensorComponent,
    accessory: PlatformAccessory,
    SelectedService: typeof Service.TemperatureSensor | typeof Service.HumiditySensor,
    SelectedCharacteristic: typeof Characteristic.CurrentTemperature | typeof Characteristic.CurrentRelativeHumidity,
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

const airQualitySetup = (component: SensorComponent, accessory: PlatformAccessory): void => {
    let targetSensor: HAPService | undefined = accessory.services.find(
        (service) => service.UUID === Service.AirQualitySensor.UUID,
    );
    if (!targetSensor) {
        targetSensor = accessory.addService(new Service.AirQualitySensor(component.name, ''));
    }

    component.state$
        .pipe(
            // @ts-ignore
            tap(() => {
                const pm25 = component.value;
                let level: number;
                // https://www.epa.gov/sites/default/files/2016-04/documents/2012_aqi_factsheet.pdf
                // https://developers.homebridge.io/#/characteristic/AirQuality
                if (!pm25) {
                    level = Characteristic.AirQuality.UNKNOWN;
                } else if (pm25 <= 12) {
                    level = Characteristic.AirQuality.EXCELLENT;
                } else if (pm25 <= 35) {
                    level = Characteristic.AirQuality.GOOD;
                } else if (pm25 <= 55) {
                    level = Characteristic.AirQuality.FAIR;
                } else if (pm25 <= 150) {
                    level = Characteristic.AirQuality.INFERIOR;
                } else {
                    level = Characteristic.AirQuality.POOR;
                }

                targetSensor?.getCharacteristic(Characteristic.PM2_5Density)?.setValue(component.value!);
                targetSensor?.getCharacteristic(Characteristic.AirQuality)?.setValue(level);
            }),
        )
        .subscribe();
};
