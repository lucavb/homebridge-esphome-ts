import type { API, CharacteristicValue, PlatformAccessory } from 'homebridge';
import { FanComponent, FanDirection } from 'esphome-ts';
import type { BaseComponent } from 'esphome-ts';

import { bindComponent } from './componentBinding.js';
import type { ComponentBinding, ComponentHelperOptions } from './componentBinding.js';

/** ESPHome uses the empty string for "no preset"; it is not a preset name. */
const NO_PRESET = '';

/**
 * ESPHome fans map onto HomeKit's Fanv2 service:
 *
 * - `Active` carries on/off. Fanv2 does not define `On`, and the Home app reads Active.
 * - `RotationSpeed` carries the reported percentage (0..100). `minStep` stays at hap's
 *   default: a step of 100/speedCount makes hap clamp maxValue below 100 for some
 *   counts (11, 22, 44, 83, 88, 91), losing the top level. The device echo snaps the
 *   slider instead.
 * - `RotationDirection` maps forward to clockwise by default. Wiring conventions vary,
 *   so a device can invert the mapping.
 * - `SwingMode` carries the single oscillation boolean.
 * - Preset modes become one Switch service each; HomeKit has no preset characteristic.
 *
 * The speed is deliberately not zeroed when the fan turns off: ESPHome retains the last
 * level while off, and pushing zero makes HomeKit jump to 100% on the next activation
 * (homebridge#3645).
 *
 * Two limits are documented rather than worked around: a fan whose device speed level is
 * still 0 (first boot, nothing restored) reports 0 while off, so the controller's activation
 * write can make the firmware run at 100% for the milliseconds before a same-gesture speed
 * write lands — ESPHome itself sets speed to the maximum when turning on at level 0; and
 * percentages are exact only for speed counts up to 100, because HAP's RotationSpeed domain
 * is 0..100.
 *
 * Before the first state push, GETs serve benign rest values (INACTIVE / CLOCKWISE /
 * SWING_DISABLED) instead of erroring like cover position: those values are safe defaults,
 * and a No Response flash would be worse. A push skips a direction or oscillation row whose
 * field is still unreported. */
export const fanHelper = (
    component: BaseComponent,
    accessory: PlatformAccessory,
    api: API,
    options: ComponentHelperOptions = {},
): (() => void) | undefined => {
    if (!(component instanceof FanComponent)) {
        return undefined;
    }

    const { Characteristic: CharacteristicClass, Service } = api.hap;
    const { ACTIVE, INACTIVE } = CharacteristicClass.Active;
    const { CLOCKWISE, COUNTER_CLOCKWISE } = CharacteristicClass.RotationDirection;
    const { SWING_DISABLED, SWING_ENABLED } = CharacteristicClass.SwingMode;
    const invertDirection = options.invertFanDirection === true;

    const toHomeKitDirection = (direction: FanDirection): number =>
        (direction === FanDirection.FAN_DIRECTION_FORWARD) !== invertDirection ? CLOCKWISE : COUNTER_CLOCKWISE;

    const toEspDirection = (value: CharacteristicValue): FanDirection | undefined => {
        if (value === CLOCKWISE) {
            return invertDirection ? FanDirection.FAN_DIRECTION_REVERSE : FanDirection.FAN_DIRECTION_FORWARD;
        }
        if (value === COUNTER_CLOCKWISE) {
            return invertDirection ? FanDirection.FAN_DIRECTION_FORWARD : FanDirection.FAN_DIRECTION_REVERSE;
        }
        return undefined;
    };

    /**
     * HomeKit treats RotationSpeed 0 as off, so a running fan must never report 0. ESPHome
     * can report level 0 (unknown) right after boot; clamp that to 1 rather than invent a
     * level. When the fan is off, report the retained level so activation resumes it.
     */
    const reportedSpeed = (): number => {
        const percentage = component.speedPercentage ?? 0;
        return component.status ? Math.max(1, percentage) : percentage;
    };

    const active = (): CharacteristicValue => (component.status ? ACTIVE : INACTIVE);

    const bindings: ComponentBinding[] = [
        {
            service: Service.Fanv2,
            name: component.name,
            characteristic: CharacteristicClass.Active,
            read: active,
            apply: (value) => {
                const isActive = value === ACTIVE;
                if (isActive !== component.status) {
                    if (isActive) {
                        component.turnOn();
                    } else {
                        component.turnOff();
                    }
                }
            },
            project: active,
        },
    ];

    if (component.supportsSpeed) {
        bindings.push({
            service: Service.Fanv2,
            name: component.name,
            characteristic: CharacteristicClass.RotationSpeed,
            read: reportedSpeed,
            apply: (value) => {
                if (typeof value === 'number') {
                    component.setSpeedPercentage(value);
                }
            },
            project: reportedSpeed,
        });
    }

    if (component.supportsDirection) {
        bindings.push({
            service: Service.Fanv2,
            name: component.name,
            characteristic: CharacteristicClass.RotationDirection,
            // A GET before the first state has no device report. Serve ESPHome's forward
            // default instead of erroring like cover position: direction is non-critical and
            // the initial state batch follows immediately. Pushes still skip while unknown.
            read: () => toHomeKitDirection(component.direction ?? FanDirection.FAN_DIRECTION_FORWARD),
            apply: (value) => {
                const direction = toEspDirection(value);
                if (direction !== undefined) {
                    component.setDirection(direction);
                }
            },
            project: () => {
                const direction = component.direction;
                return direction === undefined ? undefined : toHomeKitDirection(direction);
            },
        });
    }

    if (component.supportsOscillation) {
        bindings.push({
            service: Service.Fanv2,
            name: component.name,
            characteristic: CharacteristicClass.SwingMode,
            // Same pre-state fallback as direction: report the device default (swinging off)
            // until the first state arrives; pushes skip while unknown.
            read: () => {
                const oscillating = component.oscillating;
                return oscillating === undefined ? SWING_DISABLED : oscillating ? SWING_ENABLED : SWING_DISABLED;
            },
            apply: (value) => {
                if (value === SWING_ENABLED) {
                    component.setOscillating(true);
                } else if (value === SWING_DISABLED) {
                    component.setOscillating(false);
                }
            },
            project: () => {
                const oscillating = component.oscillating;
                return oscillating === undefined ? undefined : oscillating ? SWING_ENABLED : SWING_DISABLED;
            },
        });
    }

    const presets = [...new Set(component.supportedPresetModes)].filter((preset) => preset !== '');
    bindings.push(
        ...presets.map((preset): ComponentBinding => {
            const selected = (): boolean => component.presetMode === preset;
            return {
                service: Service.Switch,
                name: `${component.name} - ${preset}`,
                subtype: `${preset} Fan Preset`,
                characteristic: CharacteristicClass.On,
                read: selected,
                apply: (value) => {
                    if (value) {
                        component.setPresetMode(preset);
                    } else if (component.presetMode === preset) {
                        // Clearing an inactive preset would wipe whichever preset is active.
                        component.setPresetMode(NO_PRESET);
                    }
                },
                project: selected,
                radioGroup: `${component.name}-presets`,
            };
        }),
    );

    return bindComponent(component, accessory, api, bindings);
};
