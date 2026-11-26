import type { API, CharacteristicValue, PlatformAccessory } from 'homebridge';
import {
    ClimateComponent,
    ClimateAction,
    ClimateFanMode,
    ClimateMode,
    ClimateSwingMode,
    TemperatureUnit,
} from 'esphome-ts';
import type { BaseComponent, ClimateStateEvent } from 'esphome-ts';

import { bindComponent } from './componentBinding.js';
import type { ComponentBinding } from './componentBinding.js';

/**
 * Mapping conventions follow Home Assistant's HomeKit Thermostat bridge
 * (homeassistant/components/homekit/type_thermostats.py, climate_base.py,
 * climate_util.py):
 *
 * - ESPHome ClimateMode → HAP target state: OFF→OFF, HEAT→HEAT, COOL→COOL,
 *   HEAT_COOL (the legacy auto wire value 1) and AUTO (the newer value 6)→AUTO,
 *   FAN_ONLY/DRY→COOL — HA maps DRY and FAN_ONLY onto the COOL slot so a
 *   dry-only device still gets a usable mode control.
 * - ESPHome ClimateAction → HAP current state: OFF/IDLE→OFF, HEATING and
 *   DEFROSTING→HEAT, COOLING/DRYING/FAN→COOL (HA's HC_HASS_TO_HOMEKIT_ACTION).
 * - HAP temperatures are Celsius: a device reporting °F (or the protocol's °K)
 *   has every value converted, and TemperatureDisplayUnits follows the device
 *   unit (HAP has no Kelvin, so Kelvin devices read back as °C).
 * - The advertised visual temperature range becomes the characteristic's
 *   minValue/maxValue, clamped to ≥0 (negative bounds crash the Home app),
 *   rounded inward to the 0.1 step, keeping the HAP default step of 0.1 for
 *   unit-conversion precision (HA sets no minStep either).
 * - Two-point devices get Cooling/HeatingThresholdTemperature; a bare
 *   TargetTemperature write routes to the bound the current mode works with
 *   (HA's heat→low, cool→high routing); threshold writes send both bounds in
 *   one command because firmware validates low ≤ high only on a joint arrival.
 * - Fan modes map onto a linked Fanv2 service, built only when there is
 *   something to control — an ordered speed slider, an auto toggle the device
 *   can also leave, or a swing with an off position (HA's fan_chars gate plus
 *   that one condition, which real firmware always satisfies since ESPHome
 *   seeds SWING_OFF; type_thermostats.py builds no fan service for a plain
 *   on/off fan either): the ordered speeds [LOW, MIDDLE, MEDIUM, HIGH] become
 *   RotationSpeed steps (HA's ORDERED_FAN_SPEEDS), FAN_AUTO becomes
 *   TargetFanState, the Active toggle commands FAN_OFF/the on-mode, and swing
 *   becomes the binary SwingMode characteristic. CurrentFanState comes from
 *   the climate action (HA's HC_HASS_TO_HOMEKIT_FAN_STATE).
 * - Presets and custom fan/preset names have no HomeKit representation in
 *   HA's bridge either; they stay unexposed (commandable from ESPHome/HA side).
 *
 * Value characteristics whose device value can be legitimately absent (no
 * measurement yet) carry no read handler, like sensor.ts: hap serves the last
 * pushed value or its class default, and a missing_state frame must not
 * overwrite the last real reading. Mode-like characteristics whose getters
 * suppress to undefined read back as the corresponding HAP default (OFF /
 * INACTIVE / MANUAL).
 */

const isFahrenheit = (unit: TemperatureUnit): boolean => unit === TemperatureUnit.TEMPERATURE_UNIT_FAHRENHEIT;

const toCelsius = (value: number, unit: TemperatureUnit): number => {
    if (isFahrenheit(unit)) {
        return ((value - 32) * 5) / 9;
    }
    if (unit === TemperatureUnit.TEMPERATURE_UNIT_KELVIN) {
        return value - 273.15;
    }
    return value;
};

const fromCelsius = (celsius: number, unit: TemperatureUnit): number => {
    if (isFahrenheit(unit)) {
        return (celsius * 9) / 5 + 32;
    }
    if (unit === TemperatureUnit.TEMPERATURE_UNIT_KELVIN) {
        return celsius + 273.15;
    }
    return celsius;
};

/** HA's ordered fan speeds (climate_util.py ORDERED_FAN_SPEEDS), in HomeKit slider order. */
const ORDERED_FAN_SPEEDS = [
    ClimateFanMode.CLIMATE_FAN_LOW,
    ClimateFanMode.CLIMATE_FAN_MIDDLE,
    ClimateFanMode.CLIMATE_FAN_MEDIUM,
    ClimateFanMode.CLIMATE_FAN_HIGH,
];

/**
 * HA's percentage_to_ordered_list_item: a percentage picks the
 * ceil(percentage·n/100)-th item, clamped into the list.
 */
const fanSpeedForPercentage = (speeds: ClimateFanMode[], percentage: number): ClimateFanMode => {
    const index = Math.min(speeds.length, Math.max(1, Math.ceil((percentage * speeds.length) / 100)));
    return speeds[index - 1];
};

/**
 * Inverse of {@link fanSpeedForPercentage}: the item's 1-based index becomes
 * floor(index·100/n) (HA's ordered_list_item_to_percentage is floor division).
 */
const percentageForFanSpeed = (speeds: ClimateFanMode[], fanMode: ClimateFanMode): number =>
    Math.floor(((speeds.indexOf(fanMode) + 1) * 100) / speeds.length);

export const climateHelper = (
    component: BaseComponent,
    accessory: PlatformAccessory,
    api: API,
): (() => void) | undefined => {
    if (!(component instanceof ClimateComponent)) {
        return undefined;
    }
    const { Characteristic: CharacteristicClass, Service } = api.hap;
    const { TemperatureDisplayUnits, TargetHeatingCoolingState, CurrentHeatingCoolingState } = CharacteristicClass;

    const unit = component.temperatureUnit;
    /** Device-unit value → HAP Celsius; undefined passes through. */
    const toHap = (value: number | undefined): number | undefined =>
        value === undefined ? undefined : toCelsius(value, unit);
    /** HAP Celsius → device unit. */
    const toDevice = (celsius: number): number => fromCelsius(celsius, unit);

    /** ESPHome mode → HAP target state (HA's HC_HASS_TO_HOMEKIT preference order). */
    const modeToHomeKit = (mode: ClimateMode): number => {
        if (mode === ClimateMode.CLIMATE_MODE_OFF) {
            return TargetHeatingCoolingState.OFF;
        }
        if (mode === ClimateMode.CLIMATE_MODE_HEAT) {
            return TargetHeatingCoolingState.HEAT;
        }
        if (mode === ClimateMode.CLIMATE_MODE_HEAT_COOL || mode === ClimateMode.CLIMATE_MODE_AUTO) {
            return TargetHeatingCoolingState.AUTO;
        }
        // COOL, DRY and FAN_ONLY all drive the COOL slot (HA's mapping).
        return TargetHeatingCoolingState.COOL;
    };

    /**
     * HAP target state → ESPHome mode. The COOL slot drives a COOL device, else
     * DRY, else FAN_ONLY — HA maps all three onto the COOL slot, and where HA
     * must pick between DRY and FAN_ONLY its reverse dict keeps whichever the
     * comprehension visited last (FAN_ONLY); this plugin deliberately prefers
     * DRY as the mode closer to actual cooling. AUTO prefers the legacy
     * HEAT_COOL wire value like HA prefers HVACMode HEAT_COOL over AUTO.
     * Undefined when the HAP value maps to nothing the device advertises.
     *
     * Divergence from HA, documented: HA also accepts a target mode the device
     * does not support (`allow_invalid_client_values`) and re-routes Siri's
     * unconditional AUTO writes to HEAT or COOL by target-vs-current temperature
     * (type_thermostats.py HC_HEAT_COOL_PREFER_*). hap-nodejs has no
     * allow-invalid-values escape — the validValues props reject such a write
     * before this handler runs — so a Siri "cool to…" on a heat/cool-only
     * device fails with a write error instead of being silently re-routed.
     */
    const homeKitToMode = (value: number): ClimateMode | undefined => {
        const supported = component.supportedModes;
        const firstSupported = (...candidates: ClimateMode[]): ClimateMode | undefined =>
            candidates.find((candidate) => supported.includes(candidate));
        switch (value) {
            case TargetHeatingCoolingState.OFF:
                // OFF is accepted without requiring it in the advertised list
                // (firmware seeds its set with it, like esphome-ts setMode).
                return ClimateMode.CLIMATE_MODE_OFF;
            case TargetHeatingCoolingState.HEAT:
                return firstSupported(ClimateMode.CLIMATE_MODE_HEAT);
            case TargetHeatingCoolingState.COOL:
                return firstSupported(
                    ClimateMode.CLIMATE_MODE_COOL,
                    ClimateMode.CLIMATE_MODE_DRY,
                    ClimateMode.CLIMATE_MODE_FAN_ONLY,
                );
            case TargetHeatingCoolingState.AUTO:
                return firstSupported(ClimateMode.CLIMATE_MODE_HEAT_COOL, ClimateMode.CLIMATE_MODE_AUTO);
        }
        return undefined;
    };

    /** HAP values HomeKit may target, from the advertised modes. */
    const validTargetValues = (): number[] | undefined => {
        const supported = component.supportedModes;
        if (supported.length === 0) {
            return undefined; // nothing advertised: keep the HAP class defaults
        }
        return [...new Set(supported.map(modeToHomeKit))].sort((a, b) => a - b);
    };
    const validValues = validTargetValues();

    /**
     * The mode HomeKit last commanded, ahead of the device echo. Siri and
     * automations batch a mode change and a setpoint into one HAP request, so
     * the two-point setpoint routing must follow the commanded mode, not the
     * stale echo — the same echo-lag class cover.ts solves with its
     * commandedTarget. Every accepted mode change re-syncs this through the
     * state push (a mode echo always differs in the mode field, so esphome-ts's
     * shallow-dedup never drops it); a refused write produces no echo until
     * some other climate field changes, and until then the commanded mode is
     * the freshest knowledge there is.
     */
    let commandedMode: ClimateMode | undefined;
    /** Freshest mode knowledge: the commanded mode before the echo, the echo after it. */
    const routingMode = (): ClimateMode | undefined => commandedMode ?? component.mode;

    /** ESPHome action → HAP current state (HA's HC_HASS_TO_HOMEKIT_ACTION). */
    const actionToHomeKit = (action: ClimateAction | undefined): number => {
        if (action === ClimateAction.CLIMATE_ACTION_HEATING || action === ClimateAction.CLIMATE_ACTION_DEFROSTING) {
            return CurrentHeatingCoolingState.HEAT;
        }
        if (
            action === ClimateAction.CLIMATE_ACTION_COOLING ||
            action === ClimateAction.CLIMATE_ACTION_DRYING ||
            action === ClimateAction.CLIMATE_ACTION_FAN
        ) {
            return CurrentHeatingCoolingState.COOL;
        }
        // OFF, IDLE and no valid state yet.
        return CurrentHeatingCoolingState.OFF;
    };

    /**
     * The advertised visual range as HAP props, HA-style (climate_util.py
     * get_temperature_range_from_state): converted to Celsius, order-corrected,
     * rounded inward to the 0.1 step so a slider write cannot produce a value
     * the firmware rejects, min clamped to ≥0 (the Home app cannot render
     * negative bounds). The rounding runs on the decoded float32 value like
     * HA's does, so a bound whose float32 noise crosses a 0.1 boundary can
     * round a full step inward (an advertised 20.2 may become 20.3) — bounded
     * range loss only, never an out-of-range write. Undefined when the
     * advertised range is degenerate — proto-default 0..0 from firmware that
     * sends none, or an all-negative range the ≥0 clamp collapses — keeping
     * the HAP class defaults instead (a HomeKit slider cannot reach
     * below-zero setpoints either way).
     */
    const temperatureRangeProps = (): { minValue: number; maxValue: number } | undefined => {
        const min = toCelsius(component.visualMinTemperature, unit);
        const max = toCelsius(component.visualMaxTemperature, unit);
        const [low, high] = min <= max ? [min, max] : [max, min];
        let roundedMin = Math.ceil(low * 10) / 10;
        let roundedMax = Math.floor(high * 10) / 10;
        if (roundedMin > roundedMax) {
            roundedMin = low;
            roundedMax = high;
        }
        roundedMin = Math.max(roundedMin, 0);
        if (roundedMax <= roundedMin) {
            return undefined;
        }
        return { minValue: roundedMin, maxValue: roundedMax };
    };
    const rangeProps = temperatureRangeProps();

    /**
     * The single-setpoint view of the target, HA-style (type_thermostats.py
     * async_update_state): two-point devices serve the low bound while heating
     * and the high bound while cooling; in heat/cool mode HomeKit renders the
     * threshold pair instead, so no single target exists.
     */
    const liveTarget = (): number | undefined => {
        if (component.supportsTwoPointTargetTemperature) {
            const mode = component.mode;
            if (mode === ClimateMode.CLIMATE_MODE_HEAT) {
                return toHap(component.targetTemperatureLow);
            }
            if (mode === ClimateMode.CLIMATE_MODE_COOL) {
                return toHap(component.targetTemperatureHigh);
            }
            return undefined;
        }
        return toHap(component.targetTemperature);
    };

    const bindings: ComponentBinding[] = [
        {
            service: Service.Thermostat,
            name: component.name,
            characteristic: TargetHeatingCoolingState,
            props: validValues === undefined ? undefined : { validValues },
            read: () => {
                const mode = routingMode();
                if (mode !== undefined) {
                    return modeToHomeKit(mode);
                }
                // No valid state yet: serve the first advertised value — hap's
                // own getDefaultValue semantics for validValues characteristics
                // (returning the class default OFF here would trip hap's
                // validateUserInput revert on every GET for devices that do not
                // advertise OFF).
                return validValues?.[0] ?? TargetHeatingCoolingState.OFF;
            },
            apply: (value) => {
                if (typeof value !== 'number') {
                    return;
                }
                const mode = homeKitToMode(value);
                if (mode !== undefined) {
                    commandedMode = mode;
                    component.setMode(mode);
                }
            },
            // The mode getter suppresses missing_state frames to undefined, so
            // no explicit flag check is needed here (unlike the rows whose
            // getters would map undefined onto a concrete OFF/INACTIVE claim).
            project: () => {
                const mode = component.mode;
                if (mode === undefined) {
                    return undefined;
                }
                commandedMode = mode;
                // HA pushes the slot-shared value for modes that share a HAP
                // slot (a COOL+DRY device in DRY shows COOL —
                // type_thermostats.py pushes the mapped slot whenever it has
                // any backing mode). A mode mapping onto no advertised slot at
                // all (firmware reporting outside its own list) is not pushed:
                // it would land outside the characteristic's validValues —
                // HA's "Cannot map hvac target mode" case.
                const target = modeToHomeKit(mode);
                return validValues === undefined || validValues.includes(target) ? target : undefined;
            },
        },
        {
            // No read handler on purpose (sensor.ts pattern): a device without a
            // measurement serves the HAP default, and a missing_state frame must
            // not overwrite the last real reading.
            service: Service.Thermostat,
            name: component.name,
            characteristic: CharacteristicClass.CurrentTemperature,
            project: () => toHap(component.currentTemperature),
        },
        {
            service: Service.Thermostat,
            name: component.name,
            characteristic: CharacteristicClass.TargetTemperature,
            props: rangeProps,
            apply: (value) => {
                if (typeof value !== 'number') {
                    return;
                }
                const targetDevice = toDevice(value);
                if (component.supportsTwoPointTargetTemperature) {
                    // HA routes a bare target write to the bound the current
                    // mode works with; in heat/cool mode HomeKit writes the
                    // threshold pair instead, so nothing is left to route (HA
                    // drops it too). The routing follows the commanded mode:
                    // a batched Siri write pairs the mode with the setpoint
                    // before the device echoes the mode change.
                    const mode = routingMode();
                    if (mode === ClimateMode.CLIMATE_MODE_HEAT) {
                        component.setTargetTemperatureLow(targetDevice);
                    } else if (mode === ClimateMode.CLIMATE_MODE_COOL) {
                        component.setTargetTemperatureHigh(targetDevice);
                    }
                    return;
                }
                component.setTargetTemperature(targetDevice);
            },
            project: () => liveTarget(),
        },
        {
            // Static per discovery: HAP has no Kelvin, so Fahrenheit devices
            // display °F and every other unit displays °C alongside converted
            // values.
            service: Service.Thermostat,
            name: component.name,
            characteristic: TemperatureDisplayUnits,
            read: () => (isFahrenheit(unit) ? TemperatureDisplayUnits.FAHRENHEIT : TemperatureDisplayUnits.CELSIUS),
        },
    ];

    // Devices that report an action get the live current-state row; without it
    // the characteristic stays at its HAP default OFF.
    if (component.supportsAction) {
        bindings.unshift({
            service: Service.Thermostat,
            name: component.name,
            characteristic: CurrentHeatingCoolingState,
            read: () => actionToHomeKit(component.action),
            project: (state: ClimateStateEvent) => (state.missingState ? undefined : actionToHomeKit(component.action)),
        });
    }

    /**
     * Threshold pair for two-point devices. A write sends both bounds in one
     * command (firmware validates low ≤ high only on a joint arrival); the
     * unchanged side comes from the live device state, collapsing onto the
     * moved side when it is missing or would invert the range. HA keeps a 5°C
     * deadband instead — an HA comfort convention the firmware does not
     * enforce, so none is invented here.
     */
    if (component.supportsTwoPointTargetTemperature) {
        const liveLow = (): number | undefined => toHap(component.targetTemperatureLow);
        const liveHigh = (): number | undefined => toHap(component.targetTemperatureHigh);
        const applyRange = (value: CharacteristicValue, moved: 'low' | 'high'): void => {
            if (typeof value !== 'number') {
                return;
            }
            const movedDevice = toDevice(value);
            if (moved === 'low') {
                const liveHighDevice = component.targetTemperatureHigh;
                component.setTargetTemperatureRange(
                    movedDevice,
                    liveHighDevice === undefined || liveHighDevice < movedDevice ? movedDevice : liveHighDevice,
                );
                return;
            }
            const liveLowDevice = component.targetTemperatureLow;
            component.setTargetTemperatureRange(
                liveLowDevice === undefined || liveLowDevice > movedDevice ? movedDevice : liveLowDevice,
                movedDevice,
            );
        };
        bindings.push(
            {
                service: Service.Thermostat,
                name: component.name,
                characteristic: CharacteristicClass.CoolingThresholdTemperature,
                props: rangeProps,
                apply: (value) => applyRange(value, 'high'),
                project: () => liveHigh(),
            },
            {
                service: Service.Thermostat,
                name: component.name,
                characteristic: CharacteristicClass.HeatingThresholdTemperature,
                props: rangeProps,
                apply: (value) => applyRange(value, 'low'),
                project: () => liveLow(),
            },
        );
    }

    if (component.supportsCurrentHumidity) {
        // No read handler on purpose (sensor.ts pattern).
        bindings.push({
            service: Service.Thermostat,
            name: component.name,
            characteristic: CharacteristicClass.CurrentRelativeHumidity,
            project: () => component.currentHumidity,
        });
    }
    if (component.supportsTargetHumidity) {
        // Min bound only: HA reports the Home app shifts the slider range when
        // a max humidity is set (type_thermostats.py TargetRelativeHumidity).
        // The advertised minimum is applied uncorrected (HA order-corrects a
        // reversed humidity pair first; firmware sending min > max is
        // pathological, and no usable bound would come of it anyway).
        const minHumidity = component.visualMinHumidity > 0 ? { minValue: component.visualMinHumidity } : undefined;
        bindings.push({
            service: Service.Thermostat,
            name: component.name,
            characteristic: CharacteristicClass.TargetRelativeHumidity,
            props: minHumidity,
            apply: (value) => {
                if (typeof value === 'number') {
                    component.setTargetHumidity(value);
                }
            },
            project: () => component.targetHumidity,
        });
    }

    /**
     * Linked Fanv2 service (HA climate_base.py _configure_fan_service): built
     * only when there is something to control — ordered speeds, an auto toggle
     * the device can also leave (FAN_AUTO with FAN_ON or speeds to fall back
     * on), or a swing.
     */
    const speeds = ORDERED_FAN_SPEEDS.filter((speed) => component.supportedFanModes.includes(speed));
    const hasAutoToggle =
        component.supportedFanModes.includes(ClimateFanMode.CLIMATE_FAN_AUTO) &&
        (component.supportedFanModes.includes(ClimateFanMode.CLIMATE_FAN_ON) || speeds.length > 0);
    const swingOnMode = [
        ClimateSwingMode.CLIMATE_SWING_BOTH,
        ClimateSwingMode.CLIMATE_SWING_HORIZONTAL,
        ClimateSwingMode.CLIMATE_SWING_VERTICAL,
    ].find((mode) => component.supportedSwingModes.includes(mode));
    const hasSwingToggle =
        swingOnMode !== undefined && component.supportedSwingModes.includes(ClimateSwingMode.CLIMATE_SWING_OFF);

    if (speeds.length > 0 || hasAutoToggle || hasSwingToggle) {
        const { Active, CurrentFanState, RotationSpeed, SwingMode, TargetFanState } = CharacteristicClass;
        /**
         * The mode a fan-on write picks: HA's 50% speed item when ordered
         * speeds exist, else FAN_ON (climate_base.py _get_on_mode prefers the
         * speed over FAN_ON).
         */
        const onMode =
            speeds.length > 0
                ? fanSpeedForPercentage(speeds, 50)
                : component.supportedFanModes.includes(ClimateFanMode.CLIMATE_FAN_ON)
                  ? ClimateFanMode.CLIMATE_FAN_ON
                  : undefined;
        const fanOffMode = component.supportedFanModes.includes(ClimateFanMode.CLIMATE_FAN_OFF)
            ? ClimateFanMode.CLIMATE_FAN_OFF
            : undefined;
        const isFanActive = (): boolean => {
            const mode = component.mode;
            if (mode === undefined || mode === ClimateMode.CLIMATE_MODE_OFF) {
                return false;
            }
            return (
                (component.fanMode !== undefined && component.fanMode !== ClimateFanMode.CLIMATE_FAN_OFF) ||
                component.customFanMode !== undefined
            );
        };
        const fanBindings: ComponentBinding[] = [
            {
                // Active is mandatory on Fanv2. A direction the device cannot
                // obey (off without FAN_OFF, on without an on-mode) rejects the
                // write — the binding converts the throw into a HapStatusError,
                // hap does not store the value, and the tile stays unchanged,
                // like HA's _reject_char_write in _set_fan_active. Silent
                // acceptance would be worse: esphome-ts shallow-dedups identical
                // re-sent states, so a stored-but-uncommanded toggle never
                // corrects. Divergence from HA, documented: _set_fan_active
                // rejects every Active write when FAN_OFF is missing, so HA's
                // Active is dead on a speeds-without-FAN_OFF device; this
                // plugin still accepts the on-direction there and commands the
                // on-mode.
                service: Service.Fanv2,
                name: `${component.name} Fan`,
                characteristic: Active,
                read: () => (isFanActive() ? Active.ACTIVE : Active.INACTIVE),
                apply: (value) => {
                    if (value === Active.INACTIVE) {
                        if (fanOffMode === undefined) {
                            throw new Error('device has no off fan mode');
                        }
                        component.setFanMode(fanOffMode);
                        return;
                    }
                    if (onMode === undefined) {
                        throw new Error('device has no on fan mode');
                    }
                    component.setFanMode(onMode);
                },
                project: (state: ClimateStateEvent) =>
                    state.missingState ? undefined : isFanActive() ? Active.ACTIVE : Active.INACTIVE,
            },
        ];
        if (speeds.length > 0) {
            fanBindings.push({
                // HA slider semantics (climate_util.py fan_speed_to_mode): the
                // percentage shifts down by one before percentage_to_ordered_
                // list_item picks the item, "so the lowest slider step maps to
                // the first ordered speed". Non-speed modes keep the last
                // slider position, so no push happens for them. The shift also
                // keeps hap's unquantized fractional minStep deliveries
                // (66.67 for three speeds) on the speed they visually
                // represent, and moves the integer-write boundaries one point
                // up (3 speeds: 35, not 34, first maps to the middle speed) —
                // HA's boundaries behave identically.
                service: Service.Fanv2,
                name: `${component.name} Fan`,
                characteristic: RotationSpeed,
                props: { minStep: 100 / speeds.length },
                apply: (value) => {
                    if (typeof value === 'number' && value > 0) {
                        component.setFanMode(fanSpeedForPercentage(speeds, value - 1));
                    }
                },
                project: () => {
                    const fanMode = component.fanMode;
                    return fanMode === undefined || !speeds.includes(fanMode)
                        ? undefined
                        : percentageForFanSpeed(speeds, fanMode);
                },
            });
        }
        if (hasAutoToggle) {
            fanBindings.push({
                service: Service.Fanv2,
                name: `${component.name} Fan`,
                characteristic: TargetFanState,
                // Pre-state reads claim MANUAL — the HAP default — while the
                // project path below skips such frames instead of claiming
                // "not auto"; a stored value or a push corrects it either way.
                read: () =>
                    component.fanMode === ClimateFanMode.CLIMATE_FAN_AUTO ? TargetFanState.AUTO : TargetFanState.MANUAL,
                apply: (value) => {
                    if (value === TargetFanState.AUTO) {
                        component.setFanMode(ClimateFanMode.CLIMATE_FAN_AUTO);
                    } else if (onMode !== undefined) {
                        component.setFanMode(onMode);
                    }
                },
                // The fan getters are custom-fan-mode aware: both undefined
                // means no valid state yet (the protocol defaults an unpicked
                // regular fan mode to FAN_ON after the first state, so a live
                // device never reads the pair), which skips the push instead
                // of claiming "not auto".
                project: () => {
                    if (component.fanMode === undefined && component.customFanMode === undefined) {
                        return undefined;
                    }
                    return component.fanMode === ClimateFanMode.CLIMATE_FAN_AUTO
                        ? TargetFanState.AUTO
                        : TargetFanState.MANUAL;
                },
            });
        }
        if (component.supportsAction) {
            const fanState = (action: ClimateAction | undefined): number => {
                if (
                    action === ClimateAction.CLIMATE_ACTION_HEATING ||
                    action === ClimateAction.CLIMATE_ACTION_COOLING ||
                    action === ClimateAction.CLIMATE_ACTION_DRYING ||
                    action === ClimateAction.CLIMATE_ACTION_FAN
                ) {
                    return CurrentFanState.BLOWING_AIR; // (HA FAN_STATE_ACTIVE)
                }
                if (
                    action === ClimateAction.CLIMATE_ACTION_IDLE ||
                    action === ClimateAction.CLIMATE_ACTION_DEFROSTING
                ) {
                    return CurrentFanState.IDLE; // (HA FAN_STATE_IDLE)
                }
                // OFF and no valid state yet.
                return CurrentFanState.INACTIVE; // (HA FAN_STATE_INACTIVE)
            };
            fanBindings.push({
                service: Service.Fanv2,
                name: `${component.name} Fan`,
                characteristic: CurrentFanState,
                read: () => fanState(component.action),
                project: (state: ClimateStateEvent) => (state.missingState ? undefined : fanState(component.action)),
            });
        }
        if (hasSwingToggle) {
            fanBindings.push({
                service: Service.Fanv2,
                name: `${component.name} Fan`,
                characteristic: SwingMode,
                read: () => {
                    const swingMode = component.swingMode;
                    return swingMode !== undefined && swingMode !== ClimateSwingMode.CLIMATE_SWING_OFF
                        ? SwingMode.SWING_ENABLED
                        : SwingMode.SWING_DISABLED;
                },
                apply: (value) => {
                    component.setSwingMode(
                        value === SwingMode.SWING_ENABLED ? swingOnMode : ClimateSwingMode.CLIMATE_SWING_OFF,
                    );
                },
                project: () => {
                    const swingMode = component.swingMode;
                    if (swingMode === undefined) {
                        return undefined;
                    }
                    return swingMode !== ClimateSwingMode.CLIMATE_SWING_OFF
                        ? SwingMode.SWING_ENABLED
                        : SwingMode.SWING_DISABLED;
                },
            });
        }
        bindings.push(...fanBindings);
    }

    const teardown = bindComponent(component, accessory, api, bindings);

    // Link the fan tile onto the thermostat tile like HA does
    // (climate_base.py _configure_fan_service add_linked_service).
    const thermostatService = accessory.services.find((service) => service.UUID === Service.Thermostat.UUID);
    const fanService = accessory.services.find((service) => service.UUID === Service.Fanv2.UUID);
    if (thermostatService && fanService) {
        thermostatService.addLinkedService(fanService);
    }

    return teardown;
};
