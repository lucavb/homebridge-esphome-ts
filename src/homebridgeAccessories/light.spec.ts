import { describe, expect, it, vi } from 'vitest';
import type { API, CharacteristicValue, PlatformAccessory } from 'homebridge';
import { BehaviorSubject, filter } from 'rxjs';
import type { BaseComponent, Hsv } from 'esphome-ts';
import { LightComponent } from 'esphome-ts';
import { ok } from 'node:assert/strict';

import { lightHelper } from './light.js';
import {
    assertCharacteristic,
    createFakeAccessory,
    FakeHapStatusError,
    makeFakeCharacteristicClass,
    makeFakeServiceClass,
    type FakeHapCharacteristic,
    type FakeHapService,
} from '../testing/hapFakes.js';

const ON_CHARACTERISTIC = makeFakeCharacteristicClass('on-uuid');
const HUE_CHARACTERISTIC = makeFakeCharacteristicClass('hue-uuid');
const SATURATION_CHARACTERISTIC = makeFakeCharacteristicClass('saturation-uuid');
const BRIGHTNESS_CHARACTERISTIC = makeFakeCharacteristicClass('brightness-uuid');

const LightbulbService = makeFakeServiceClass('lightbulb-uuid', [
    ON_CHARACTERISTIC,
    HUE_CHARACTERISTIC,
    SATURATION_CHARACTERISTIC,
    BRIGHTNESS_CHARACTERISTIC,
]);
const SwitchService = makeFakeServiceClass('switch-uuid', [ON_CHARACTERISTIC]);

const createFakeApi = () =>
    ({
        hap: {
            Service: { Lightbulb: LightbulbService, Switch: SwitchService },
            Characteristic: {
                On: ON_CHARACTERISTIC,
                Hue: HUE_CHARACTERISTIC,
                Saturation: SATURATION_CHARACTERISTIC,
                Brightness: BRIGHTNESS_CHARACTERISTIC,
            },
            HapStatusError: FakeHapStatusError,
            HAPStatus: { SERVICE_COMMUNICATION_FAILURE: 'SERVICE_COMMUNICATION_FAILURE' },
        },
    }) as unknown as API;

const bulbCharacteristicsOf = (accessory: PlatformAccessory) => {
    const service = accessory.services[0] as unknown as FakeHapService;
    return {
        on: assertCharacteristic(service, ON_CHARACTERISTIC),
        hue: assertCharacteristic(service, HUE_CHARACTERISTIC),
        saturation: assertCharacteristic(service, SATURATION_CHARACTERISTIC),
        brightness: assertCharacteristic(service, BRIGHTNESS_CHARACTERISTIC),
    };
};

/** Invokes the stored onSet handler directly (setValue/updateValue pushes never re-run it). */
const invokeSet = async (characteristic: FakeHapCharacteristic, value: CharacteristicValue): Promise<unknown> => {
    const handler = characteristic.setHandler;
    ok(handler, 'expected an onSet handler to be registered');
    return await handler(value);
};

/** Lets a would-be (wrong) setValue re-entry settle before asserting side effects. */
const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

interface FakeLightOptions {
    supportsRgb?: boolean;
    supportsBrightness?: boolean;
    effects?: string[];
}

/** The echoed light-state payload; project rows consume `state`, `brightness` and `effect`. */
interface FakeLightEcho {
    state?: boolean;
    brightness?: number;
    hue?: number;
    saturation?: number;
    value?: number;
    effect?: string;
}

const createFakeLightComponent = (options: FakeLightOptions = {}) => {
    /**
     * Faithful to esphome-ts v4 state$: built from a BehaviorSubject(undefined) filtered on
     * undefined, so late subscribers (each binding row) get the current state replayed at
     * subscribe time (esphome-ts dist/index.js:2777, 2788).
     */
    const state = new BehaviorSubject<unknown>(undefined);
    const state$ = state.pipe(filter((value) => value !== undefined));

    const turnOn = vi.fn();
    const turnOff = vi.fn();
    const setBrightness = vi.fn();

    // Reported state is what the device echoes back: applies (commands) never touch it —
    // only echo() does, like a device confirming a command through its next state push.
    let hsvState: Hsv = { hue: 0, saturation: 0, value: 0 };
    let effectState = 'None';
    const hsvCommands: Hsv[] = [];
    const effectCommands: string[] = [];

    /**
     * Boundary fake: sits on the real LightComponent.prototype (the helper narrows with
     * instanceof) and shadows its getters/setters with spec-owned state. The hsv getter hands
     * out a copy, so a read-modify-write apply observes the CURRENT reports. The hsv/effect
     * setters are pure command recorders — a write sends a command; the reported state changes
     * only when the device echoes it back (via echo()).
     */
    const component = Object.create(LightComponent.prototype) as LightComponent;
    Object.defineProperty(component, 'name', { enumerable: true, get: () => 'TestLight' });
    Object.defineProperty(component, 'state$', { enumerable: true, get: () => state$ });
    Object.defineProperty(component, 'supportsRgb', { enumerable: true, get: () => options.supportsRgb ?? false });
    Object.defineProperty(component, 'supportsBrightness', {
        enumerable: true,
        get: () => options.supportsBrightness ?? false,
    });
    Object.defineProperty(component, 'availableEffects', {
        enumerable: true,
        value: () => options.effects ?? [],
    });
    Object.defineProperty(component, 'hsv', {
        enumerable: true,
        get: (): Hsv => ({ ...hsvState }),
        set: (written: Hsv) => {
            hsvCommands.push({ hue: written.hue, saturation: written.saturation, value: written.value });
        },
    });
    Object.defineProperty(component, 'effect', {
        enumerable: true,
        get: () => effectState,
        set: (effect: string) => {
            effectCommands.push(effect);
        },
    });
    Object.defineProperty(component, 'turnOn', { enumerable: true, value: turnOn });
    Object.defineProperty(component, 'turnOff', { enumerable: true, value: turnOff });
    Object.defineProperty(component, 'setBrightness', { enumerable: true, value: setBrightness });

    /**
     * Device echo: updates the reported fields AND pushes the same payload on state$, like the
     * real device confirming a command or reporting a change on its own.
     */
    const echo = (changes: FakeLightEcho): void => {
        hsvState = {
            hue: changes.hue ?? hsvState.hue,
            saturation: changes.saturation ?? hsvState.saturation,
            value: changes.value ?? hsvState.value,
        };
        if (changes.effect !== undefined) {
            effectState = changes.effect;
        }
        state.next({ ...changes });
    };

    return {
        component,
        state,
        hsvCommands,
        effectCommands,
        echo,
        turnOn,
        turnOff,
        setBrightness,
    };
};

describe('lightHelper', () => {
    it('returns undefined for a component failing the instanceof guard without touching the accessory', () => {
        // A plain object is not on LightComponent.prototype, so `component instanceof
        // LightComponent` (light.ts:16) is false for it.
        const impostor = { name: 'impostor' } as unknown as BaseComponent;
        const { accessory, context } = createFakeAccessory();

        expect(lightHelper(impostor, accessory, createFakeApi())).toBeUndefined();
        expect(context.services).toHaveLength(0);
    });

    it('binds an RGB light with On, Hue, Saturation and Brightness rows; On drives turnOn/turnOff', async () => {
        const light = createFakeLightComponent({ supportsRgb: true });
        const { accessory, context } = createFakeAccessory();

        const teardown = lightHelper(light.component, accessory, createFakeApi());
        expect(teardown).toBeTypeOf('function');

        expect(context.services).toHaveLength(1);
        expect(context.services[0]).toHaveProperty('UUID', 'lightbulb-uuid');
        expect(context.services[0]).toHaveProperty('name', 'TestLight');

        const characteristics = bulbCharacteristicsOf(accessory);
        await invokeSet(characteristics.on, true);
        expect(light.turnOn).toHaveBeenCalledTimes(1);
        await invokeSet(characteristics.on, false);
        expect(light.turnOff).toHaveBeenCalledTimes(1);
        expect(light.effectCommands).toHaveLength(0); // no effect switch rows without effects
    });

    it('a hue apply writes the new hue with the lastSat ?? 0 semantics and keeps the value', async () => {
        const light = createFakeLightComponent({ supportsRgb: true });
        // Device reports its state before the helper binds; the BehaviorSubject replays it into
        // each row at subscribe time, seeding the read-modify-write baseline.
        light.echo({ state: true, hue: 10, saturation: 0, value: 40 });
        const { accessory } = createFakeAccessory();
        lightHelper(light.component, accessory, createFakeApi());
        const characteristics = bulbCharacteristicsOf(accessory);

        await invokeSet(characteristics.hue, 120);

        // Command intent: the write carries the new hue on the echoed baseline, value preserved.
        expect(light.hsvCommands).toEqual([{ hue: 120, saturation: 0, value: 40 }]);
    });

    it('a saturation apply commands the component hsv with the new saturation, preserving hue and value', async () => {
        const light = createFakeLightComponent({ supportsRgb: true });
        light.echo({ state: true, hue: 200, saturation: 0, value: 35 });
        const { accessory } = createFakeAccessory();
        lightHelper(light.component, accessory, createFakeApi());
        const characteristics = bulbCharacteristicsOf(accessory);

        // No prior hue write: the saturation lone change must reach the device untouched.
        await invokeSet(characteristics.saturation, 80);

        // Command intent: the lone saturation change is a full hsv command on the echoed
        // baseline (hue 200, value 35). A production path that stores lastSat without writing
        // hsv would record NO hsv command, and one that fails to preserve the echoed base
        // would record {0,80,0}.
        expect(light.hsvCommands).toEqual([{ hue: 200, saturation: 80, value: 35 }]);
    });

    it('saturation-then-hue: the stored lastSat is what the next hue apply writes', async () => {
        const light = createFakeLightComponent({ supportsRgb: true });
        light.echo({ state: true, hue: 10, saturation: 0, value: 25 });
        const { accessory } = createFakeAccessory();
        lightHelper(light.component, accessory, createFakeApi());
        const characteristics = bulbCharacteristicsOf(accessory);

        await invokeSet(characteristics.saturation, 60);
        expect(light.hsvCommands).toEqual([{ hue: 10, saturation: 60, value: 25 }]);

        await invokeSet(characteristics.hue, 100);
        expect(light.hsvCommands).toHaveLength(2);
        expect(light.hsvCommands[1]).toEqual({ hue: 100, saturation: 60, value: 25 });
    });

    it('an RGB brightness apply writes hsv.value', async () => {
        const light = createFakeLightComponent({ supportsRgb: true });
        light.echo({ state: true, hue: 30, saturation: 70, value: 10 });
        const { accessory } = createFakeAccessory();
        lightHelper(light.component, accessory, createFakeApi());
        const characteristics = bulbCharacteristicsOf(accessory);

        await invokeSet(characteristics.brightness, 50);

        expect(light.hsvCommands).toEqual([{ hue: 30, saturation: 70, value: 50 }]);
        expect(light.setBrightness).not.toHaveBeenCalled();
    });

    it('a non-RGB light wires only On and Brightness; brightness routes through setBrightness', async () => {
        const light = createFakeLightComponent({ supportsBrightness: true });
        const { accessory, context } = createFakeAccessory();

        lightHelper(light.component, accessory, createFakeApi());

        expect(context.services).toHaveLength(1);
        const characteristics = bulbCharacteristicsOf(accessory);
        // Hue/Saturation exist as fake instances but are never wired by the helper.
        expect(characteristics.hue.setHandler).toBeUndefined();
        expect(characteristics.hue.getHandler).toBeUndefined();
        expect(characteristics.saturation.setHandler).toBeUndefined();
        expect(characteristics.saturation.getHandler).toBeUndefined();

        await invokeSet(characteristics.brightness, 0.35);
        expect(light.setBrightness).toHaveBeenCalledWith(0.35);
        expect(light.hsvCommands).toHaveLength(0); // the non-RGB path never touches hsv
    });

    it('a non-RGB light echoes state brightness as a 0..100 percent on the Brightness characteristic', () => {
        const light = createFakeLightComponent({ supportsBrightness: true });
        const { accessory } = createFakeAccessory();
        lightHelper(light.component, accessory, createFakeApi());
        const characteristics = bulbCharacteristicsOf(accessory);

        light.state.next({ state: true, brightness: 0.3 });
        expect(characteristics.brightness.value).toBe(30);

        light.state.next({ state: true, brightness: undefined });
        expect(characteristics.brightness.value).toBe(0);
    });

    describe('effects', () => {
        const setupEffects = () => {
            const light = createFakeLightComponent({
                supportsRgb: false,
                supportsBrightness: false,
                effects: ['None', 'rainbow', 'strobe'],
            });
            const accessory = createFakeAccessory();
            lightHelper(light.component, accessory.accessory, createFakeApi());
            const switchCharacteristics = (service: FakeHapService) => assertCharacteristic(service, ON_CHARACTERISTIC);
            return {
                light,
                context: accessory.context,
                bulbOn: assertCharacteristic(accessory.context.services[0], ON_CHARACTERISTIC),
                rainbowOn: switchCharacteristics(accessory.context.services[1]),
                strobeOn: switchCharacteristics(accessory.context.services[2]),
            };
        };

        it('excludes NO_EFFECT and adds one subtype Switch service per effect', () => {
            const { context } = setupEffects();

            expect(context.services).toHaveLength(3); // bulb + two effect switches
            expect(context.services[0]).toHaveProperty('UUID', 'lightbulb-uuid');
            expect(context.services[1]).toHaveProperty('name', 'TestLight - rainbow');
            expect(context.services[1]).toHaveProperty('subtype', 'rainbow Switch');
            expect(context.services[2]).toHaveProperty('name', 'TestLight - strobe');
            expect(context.services[2]).toHaveProperty('subtype', 'strobe Switch');
        });

        it('an effect onSet activates that effect and the radioGroup silences siblings', async () => {
            // None is filtered out; NO_EFFECT never gets a service.
            const { context, light, rainbowOn, strobeOn } = setupEffects();
            expect(context.services.map((service) => service.name)).toEqual([
                'TestLight',
                'TestLight - rainbow',
                'TestLight - strobe',
            ]);

            await invokeSet(rainbowOn, true);
            // The setter records the command; the device would confirm it via echo (see the
            // state-echo test below for the reported-state readback path).
            expect(light.effectCommands).toEqual(['rainbow']);
            expect(strobeOn.value).toBe(false); // sibling silenced through updateValue

            await invokeSet(strobeOn, true);
            expect(light.effectCommands).toEqual(['rainbow', 'strobe']);
            expect(rainbowOn.value).toBe(false);

            await invokeSet(rainbowOn, false);
            expect(light.effectCommands).toEqual(['rainbow', 'strobe', 'None']); // NO_EFFECT restores the base state
        });
    });

    it('a state echo pushes On/Hue/Saturation/Brightness and effects without re-entering any apply', async () => {
        const light = createFakeLightComponent({
            supportsRgb: true,
            effects: ['None', 'rainbow', 'strobe'],
        });
        const accessory = createFakeAccessory();
        const { context } = accessory;
        lightHelper(light.component, accessory.accessory, createFakeApi());
        const bulbOn = assertCharacteristic(context.services[0], ON_CHARACTERISTIC);
        const rainbowOn = assertCharacteristic(context.services[1], ON_CHARACTERISTIC);
        const strobeOn = assertCharacteristic(context.services[2], ON_CHARACTERISTIC);

        light.echo({ state: true, hue: 10, saturation: 20, value: 30, effect: 'rainbow' });
        await flush();

        expect(bulbOn.value).toBe(true);
        expect(assertCharacteristic(context.services[0], HUE_CHARACTERISTIC).value).toBe(10);
        expect(assertCharacteristic(context.services[0], SATURATION_CHARACTERISTIC).value).toBe(20);
        expect(assertCharacteristic(context.services[0], BRIGHTNESS_CHARACTERISTIC).value).toBe(30);
        expect(rainbowOn.value).toBe(true);
        expect(strobeOn.value).toBe(false);

        // The echo is a device confirmation falling through updateValue: silent — no command
        // echoes, no effect writes.
        expect(light.turnOn).not.toHaveBeenCalled();
        expect(light.turnOff).not.toHaveBeenCalled();
        expect(light.effectCommands).toHaveLength(0);
        expect(light.hsvCommands).toHaveLength(0);
    });
});
