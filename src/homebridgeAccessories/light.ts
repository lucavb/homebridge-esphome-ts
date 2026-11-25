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
            // esphome-ts exposes no on/off accessor on LightComponent; the state event is the only truth.
            read: null,
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
        const hue = (): number => component.hsv.hue;
        const saturation = (): number => component.hsv.saturation;
        const brightness = (): number => component.hsv.value;
        bindings.push(
            {
                service: Service.Lightbulb,
                name: component.name,
                characteristic: CharacteristicClass.Hue,
                read: hue,
                apply: (hueValue) => {
                    if (typeof hueValue === 'number') {
                        lastHue = hueValue;
                        const hsv = component.hsv;
                        hsv.hue = lastHue ?? 0;
                        hsv.saturation = lastSat ?? 0;
                        component.hsv = hsv;
                    }
                },
                project: hue,
            },
            {
                service: Service.Lightbulb,
                name: component.name,
                characteristic: CharacteristicClass.Saturation,
                read: saturation,
                apply: (saturationValue) => {
                    if (typeof saturationValue === 'number') {
                        lastSat = saturationValue;
                        const hsv = component.hsv;
                        hsv.saturation = saturationValue;
                        component.hsv = hsv;
                    }
                },
                project: saturation,
            },
            {
                service: Service.Lightbulb,
                name: component.name,
                characteristic: CharacteristicClass.Brightness,
                read: brightness,
                apply: (brightnessValue) => {
                    if (typeof brightnessValue === 'number') {
                        const hsv = component.hsv;
                        hsv.value = brightnessValue;
                        component.hsv = hsv;
                    }
                },
                project: brightness,
            },
        );
    } else if (component.supportsBrightness) {
        // getBrightness() is the published 0..100 value (floor of the device's 0..1 level).
        // Before the first state it is undefined; serve 0 (hap's own Brightness default) rather
        // than erroring — the benign-rest-value exemption in CODING_STANDARDS. RGB cannot do
        // better: esphome-ts's `hsv` collapses unknown to {0, 0, 0} anyway.
        const brightness = (): number => component.getBrightness() ?? 0;
        bindings.push({
            service: Service.Lightbulb,
            name: component.name,
            characteristic: CharacteristicClass.Brightness,
            read: brightness,
            apply: (brightnessValue) => {
                if (typeof brightnessValue === 'number') {
                    component.setBrightness(brightnessValue);
                }
            },
            project: brightness,
        });
    }

    const effects = [...new Set(component.availableEffects())]
        .filter((effect: string) => effect !== NO_EFFECT)
        .map((effect: string): ComponentBinding => {
            const selected = (): boolean => component.effect === effect;
            return {
                service: Service.Switch,
                name: `${component.name} - ${effect}`,
                subtype: `${effect} Switch`,
                characteristic: CharacteristicClass.On,
                read: selected,
                apply: (on) => {
                    if (on) {
                        component.effect = effect;
                    } else if (component.effect === effect) {
                        // Turning off an inactive effect must not clear whichever effect is active.
                        component.effect = NO_EFFECT;
                    }
                },
                project: selected,
                radioGroup: `${component.name}-effects`,
            };
        });
    bindings.push(...effects);

    return bindComponent(component, accessory, api, bindings);
};
