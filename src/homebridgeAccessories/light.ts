import type { API, PlatformAccessory } from 'homebridge';
import type { BaseComponent, LightStateEvent } from 'esphome-ts';
import { LightComponent } from 'esphome-ts';

import { bindComponent } from './componentBinding.js';
import type { ComponentBinding } from './componentBinding.js';

// DEFAULT_NO_EFFECT from esphome-ts v3 was removed in v4; its v3 value was the string 'None'.
const NO_EFFECT = 'None';

export const lightHelper = (
    component: BaseComponent,
    accessory: PlatformAccessory,
    api: API,
): (() => void) | undefined => {
    if (!(component instanceof LightComponent)) {
        return undefined;
    }
    const { Characteristic: CharacteristicClass, Service } = api.hap;

    const bindings: ComponentBinding[] = [
        {
            service: Service.Lightbulb,
            name: component.name,
            characteristic: CharacteristicClass.On,
            pushVia: 'updateValue',
            apply: (on) => {
                if (on) {
                    component.turnOn();
                } else {
                    component.turnOff();
                }
            },
            project: (state: LightStateEvent) => !!state.state,
        },
    ];

    if (component.supportsRgb) {
        let lastHue: number | undefined;
        let lastSat: number | undefined;
        bindings.push(
            {
                service: Service.Lightbulb,
                name: component.name,
                characteristic: CharacteristicClass.Hue,
                pushVia: 'updateValue',
                apply: (hue) => {
                    if (typeof hue === 'number') {
                        lastHue = hue;
                        const hsv = component.hsv;
                        hsv.hue = lastHue ?? 0;
                        hsv.saturation = lastSat ?? 0;
                        component.hsv = hsv;
                    }
                },
                project: () => component.hsv.hue,
            },
            {
                service: Service.Lightbulb,
                name: component.name,
                characteristic: CharacteristicClass.Saturation,
                pushVia: 'updateValue',
                apply: (saturation) => {
                    if (typeof saturation === 'number') {
                        lastSat = saturation;
                        const hsv = component.hsv;
                        hsv.saturation = saturation;
                        component.hsv = hsv;
                    }
                },
                project: () => component.hsv.saturation,
            },
            {
                service: Service.Lightbulb,
                name: component.name,
                characteristic: CharacteristicClass.Brightness,
                pushVia: 'updateValue',
                apply: (brightness) => {
                    if (typeof brightness === 'number') {
                        const hsv = component.hsv;
                        hsv.value = brightness;
                        component.hsv = hsv;
                    }
                },
                project: () => component.hsv.value,
            },
        );
    } else if (component.supportsBrightness) {
        bindings.push({
            service: Service.Lightbulb,
            name: component.name,
            characteristic: CharacteristicClass.Brightness,
            pushVia: 'updateValue',
            apply: (brightness) => {
                if (typeof brightness === 'number') {
                    component.setBrightness(brightness);
                }
            },
            project: (state: LightStateEvent) => (state.brightness ?? 0) * 100,
        });
    }

    const effects = component
        .availableEffects()
        .filter((effect: string) => effect !== NO_EFFECT)
        .map((effect: string): ComponentBinding => {
            return {
                service: Service.Switch,
                name: `${component.name} - ${effect}`,
                subtype: `${effect} Switch`,
                characteristic: CharacteristicClass.On,
                pushVia: 'updateValue',
                apply: (on) => {
                    component.effect = on ? effect : NO_EFFECT;
                },
                project: (state: LightStateEvent) => state.effect === effect,
                radioGroup: `${component.name}-effects`,
            };
        });
    bindings.push(...effects);

    return bindComponent(component, accessory, api, bindings);
};
