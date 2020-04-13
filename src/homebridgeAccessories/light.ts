import {Lightbulb} from 'hap-nodejs/dist/lib/gen/HomeKit';
import {
    Characteristic,
    CharacteristicEventTypes,
    CharacteristicSetCallback,
    CharacteristicValue,
    Service,
} from 'hap-nodejs';
import {HomebridgePlatformAccessory} from 'homebridge-ts-helper';
import {tap} from 'rxjs/operators';
import {ComponentHelper} from './componentHelpers';
import {LightComponent} from 'esphome-ts/dist';

export const lightHelper: ComponentHelper = (component: LightComponent, accessory: HomebridgePlatformAccessory): void => {

    let lightBulbService: Service | undefined = accessory.services.find((service) => service.UUID === Lightbulb.UUID);
    if (!lightBulbService) {
        lightBulbService = accessory.addService(new Lightbulb(component.name, ''));
    }
    component.state$.pipe(
        tap((state) => {
            const lightBulbService = accessory.getService(component.name);
            lightBulbService.getCharacteristic(Characteristic.On)?.updateValue(!!state.state);
            if (component.supportsRgb) {
                const hsv = component.hsv;
                lightBulbService.getCharacteristic(Characteristic.Hue)?.updateValue(hsv.hue);
                lightBulbService.getCharacteristic(Characteristic.Saturation)?.updateValue(hsv.saturation);
                lightBulbService.getCharacteristic(Characteristic.Brightness)?.updateValue(hsv.value);
            } else if (component.supportsBrightness) {
                lightBulbService.getCharacteristic(Characteristic.Brightness)?.updateValue((state.brightness ?? 0) * 100);
            }
        }),
    ).subscribe();

    if (component.supportsRgb) {
        let lastHue: number | undefined;
        let lastSat: number | undefined;
        lightBulbService.getCharacteristic(Characteristic.Hue)?.on(CharacteristicEventTypes.SET,
            (hue: CharacteristicValue, callback: CharacteristicSetCallback) => {
                lastHue = (hue as number);
                const hsv = component.hsv;
                hsv.hue = lastHue ?? 0;
                hsv.saturation = lastSat ?? 0;
                component.hsv = hsv;
                callback();
            });
        lightBulbService.getCharacteristic(Characteristic.Saturation)?.on(CharacteristicEventTypes.SET,
            (saturation: CharacteristicValue, callback: CharacteristicSetCallback) => {
                lastSat = (saturation as number);
                callback();
            });
        lightBulbService.getCharacteristic(Characteristic.Brightness)?.on(CharacteristicEventTypes.SET,
            (brightness: CharacteristicValue, callback: CharacteristicSetCallback) => {
                const hsv = component.hsv;
                hsv.value = (brightness as number);
                component.hsv = hsv;
                callback();
            });

    } else if (component.supportsBrightness) {
        lightBulbService.getCharacteristic(Characteristic.Brightness)?.on(CharacteristicEventTypes.SET,
            (brightness: CharacteristicValue, callback: CharacteristicSetCallback) => {
                component.setBrightness(brightness as number);
                callback();
            });
    }

    lightBulbService.getCharacteristic(Characteristic.On)?.on(CharacteristicEventTypes.SET,
        (on: CharacteristicValue, callback: CharacteristicSetCallback) => {
            !!on ? component.turnOn() : component.turnOff();
            callback();
        });

};
