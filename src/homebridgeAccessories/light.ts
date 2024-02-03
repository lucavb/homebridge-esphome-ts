import {
    CharacteristicEventTypes,
    CharacteristicSetCallback,
    CharacteristicValue,
    PlatformAccessory,
    Service as HAPService,
} from 'homebridge';
import { Characteristic, Service } from '../index';
import { ComponentHelper } from './componentHelpers';
const convert = require('color-convert');

enum ColorMode {
    WHITE = 7,
    RGB = 35,
}

export const lightHelper: ComponentHelper = (component: any, accessory: PlatformAccessory): boolean => {
    let lightBulbService: HAPService | undefined = accessory.services.find(
        (service: HAPService) => service.UUID === Service.Lightbulb.UUID,
    );
    if (!lightBulbService) {
        lightBulbService = accessory.addService(new Service.Lightbulb(component.name, ''));
    }

    const supportsRgb = component.config.legacySupportsRgb as boolean;
    const supportsBrightness = component.config.legacySupportsBrightness as boolean;
    const supportsWhiteValue = component.config.legacySupportsWhiteValue as boolean;
    const supportsColorTemperature = component.config.legacySupportsColorTemperature as boolean;

    let hsvState: number[]; // 0 = H, 1 = S, 2 = V
    let lightState: boolean;

    lightBulbService
        .getCharacteristic(Characteristic.Hue)
        ?.on(CharacteristicEventTypes.SET, (hue: CharacteristicValue, callback: CharacteristicSetCallback) => {
            hsvState[0] = hue as number;
            updateEsp();
            callback();
        });

    lightBulbService
        .getCharacteristic(Characteristic.Saturation)
        ?.on(CharacteristicEventTypes.SET, (saturation: CharacteristicValue, callback: CharacteristicSetCallback) => {
            hsvState[1] = saturation as number;
            updateEsp();
            callback();
        });

    lightBulbService
        .getCharacteristic(Characteristic.Brightness)
        ?.on(CharacteristicEventTypes.SET, (brightness: CharacteristicValue, callback: CharacteristicSetCallback) => {
            hsvState[2] = brightness as number;
            updateEsp();
            callback();
        });

    lightBulbService
        .getCharacteristic(Characteristic.On)
        ?.on(CharacteristicEventTypes.SET, (on: CharacteristicValue, callback: CharacteristicSetCallback) => {
            lightState = on as boolean;
            updateEsp();
            callback();
        });

    // TODO: Reimplement effects

    component.on('state', (state: any) => {
        lightState = state.state;
        const brightness = state.brightness ?? 0;

        lightBulbService!.getCharacteristic(Characteristic.On)?.updateValue(lightState);

        if (supportsRgb && (state.colorMode as ColorMode) === ColorMode.RGB) {
            hsvState = convert.rgb.hsv.raw(state.red * 255, state.green * 255, state.blue * 255) as number[];
            lightBulbService!.getCharacteristic(Characteristic.Hue)?.updateValue(hsvState[0]);
            lightBulbService!.getCharacteristic(Characteristic.Saturation)?.updateValue(hsvState[1]);
            lightBulbService!.getCharacteristic(Characteristic.Brightness)?.updateValue(hsvState[2] * brightness);
        } else if (supportsBrightness) {
            hsvState = convert.rgb.hsv.raw(255, 255, 255) as number[];
            lightBulbService!.getCharacteristic(Characteristic.Hue)?.updateValue(hsvState[0]);
            lightBulbService!.getCharacteristic(Characteristic.Saturation)?.updateValue(hsvState[1]);
            lightBulbService!.getCharacteristic(Characteristic.Brightness)?.updateValue(brightness * 100);
        }
    });

    function updateEsp() {
        const brightness = hsvState[2];
        hsvState[2] = 100;
        let rgb = convert.hsv.rgb.raw(hsvState);
        let mode: ColorMode = ColorMode.RGB;

        if (supportsRgb) {
            if (hsvState[0] === 0 && hsvState[1] === 0) {
                mode = ColorMode.WHITE;
                rgb = [0, 0, rgb[2]];
            }
        } else if (supportsBrightness) {
            mode = ColorMode.WHITE;
            rgb = [0, 0, rgb[2]];
        }

        const state = {
            key: component.id,
            state: lightState,
            brightness: brightness / 100,
            red: rgb[0] / 255,
            green: rgb[1] / 255,
            blue: rgb[2] / 255,
            colorMode: mode,
        };

        component.connection.lightCommandService(state);
    }

    return true;
};
