import { describe, expect, it, vi } from 'vitest';
import type { API, CharacteristicValue, PlatformAccessory } from 'homebridge';
import { Subject } from 'rxjs';
import type { SwitchComponent } from 'esphome-ts';

import { switchHelper } from './switch.js';

const SWITCH_SERVICE_UUID = '49-0000-1000-8000-0026bb765291';
const ON_CHARACTERISTIC_KEY = 'on-characteristic-uuid';

class FakeHapStatusError extends Error {}

interface FakeCharacteristic {
    value: CharacteristicValue | undefined;
    setHandler: undefined | ((value: CharacteristicValue) => Promise<void>);
    onSet: (handler: (value: CharacteristicValue) => Promise<void>) => FakeCharacteristic;
    onGet: (handler: () => Promise<CharacteristicValue> | CharacteristicValue) => FakeCharacteristic;
    setValue: (value: CharacteristicValue) => void;
    updateValue: (value: CharacteristicValue) => void;
}

const createFakeCharacteristic = (): FakeCharacteristic => {
    const characteristic: FakeCharacteristic & Record<string, unknown> = {
        value: undefined,
        setHandler: undefined,
        onSet(handler) {
            characteristic.setHandler = handler;
            return this;
        },
        onGet() {
            return this;
        },
        setValue(value) {
            characteristic.value = value;
        },
        updateValue(value) {
            characteristic.value = value;
        },
    };
    return characteristic;
};

interface FakeSwitchComponent {
    name: string;
    state$: Subject<unknown>;
    status: boolean;
    turnOn: ReturnType<typeof vi.fn>;
    turnOff: ReturnType<typeof vi.fn>;
}

/** Runtime stand-in for `api.hap.Service` (a namespace object whose props are service constructor classes). */
class FakeSwitchService {
    public static readonly UUID = SWITCH_SERVICE_UUID;
    public readonly UUID = SWITCH_SERVICE_UUID;
    public readonly name: string;
    public readonly subtype: string;
    public readonly characteristics: Map<string, FakeCharacteristic>;

    public constructor(name: string, subtype: string) {
        this.name = name;
        this.subtype = subtype;
        this.characteristics = new Map([[ON_CHARACTERISTIC_KEY, createFakeCharacteristic()]]);
    }

    public getCharacteristic(key: string): FakeCharacteristic | undefined {
        return this.characteristics.get(key);
    }
}

const ServiceClass = { Switch: FakeSwitchService };

/** Runtime stand-in for `api.hap.Characteristic`. */
const CharacteristicClass = { On: ON_CHARACTERISTIC_KEY };

const createFakeApi = () =>
    ({
        hap: {
            Service: ServiceClass,
            Characteristic: CharacteristicClass,
            HapStatusError: FakeHapStatusError,
            HAPStatus: { SERVICE_COMMUNICATION_FAILURE: 'SERVICE_COMMUNICATION_FAILURE' },
        },
    }) as unknown as API;

interface FakeAccessoryContext {
    services: PlatformAccessory['services'];
}

const createFakeAccessory = (...preExistingServices: PlatformAccessory['services']) => {
    const context: FakeAccessoryContext = { services: [...preExistingServices] };
    const accessory = {
        services: context.services,
        addService(service: PlatformAccessory['services'][number]): PlatformAccessory['services'][number] {
            context.services.push(service);
            return service;
        },
    } as unknown as PlatformAccessory;
    return { accessory, context };
};

const createFakeSwitchComponent = (options?: { throwOnCall?: boolean }) => {
    const state$ = new Subject<unknown>();
    const fake: FakeSwitchComponent = {
        state$,
        status: false,
        name: 'TestSwitch',
        turnOn: vi.fn(() => {
            if (options?.throwOnCall) {
                throw new Error('device gone');
            }
        }),
        turnOff: vi.fn(() => {
            if (options?.throwOnCall) {
                throw new Error('device gone');
            }
        }),
    };
    return {
        /** The mutable raw handle, so tests can change status without fighting readonly types. */
        raw: fake,
        component: fake as unknown as SwitchComponent,
        state$,
        turnOn: fake.turnOn,
        turnOff: fake.turnOff,
    };
};

describe('switchHelper', () => {
    it('returns true and registers the wiring', () => {
        const { component } = createFakeSwitchComponent();
        const { accessory } = createFakeAccessory();
        expect(switchHelper(component, accessory, createFakeApi())).toBe(true);
    });

    it('adds a Switch service when the accessory has none', () => {
        const { component } = createFakeSwitchComponent();
        const { accessory } = createFakeAccessory();

        switchHelper(component, accessory, createFakeApi());

        expect(accessory.services).toHaveLength(1);
        const service = accessory.services[0];
        expect(service).toHaveProperty('UUID', SWITCH_SERVICE_UUID);
        expect(service).toHaveProperty('name', 'TestSwitch');
    });

    it('reuses an existing Switch service instead of adding one', () => {
        const { component } = createFakeSwitchComponent();
        const existingService = { UUID: SWITCH_SERVICE_UUID, getCharacteristic: () => undefined };
        const { accessory } = createFakeAccessory(existingService as unknown as PlatformAccessory['services'][number]);
        const spyService = vi.spyOn(accessory, 'addService');

        switchHelper(component, accessory, createFakeApi());

        expect(spyService).not.toHaveBeenCalled();
    });

    it('wires the On characteristic of the created service through onSet', () => {
        const { component } = createFakeSwitchComponent();
        const { accessory } = createFakeAccessory();

        switchHelper(component, accessory, createFakeApi());

        const service = accessory.services[0] as unknown as FakeSwitchService;
        const onCharacteristic = service.getCharacteristic(ON_CHARACTERISTIC_KEY)!;
        expect(onCharacteristic).toBeDefined();
        expect(typeof onCharacteristic.setHandler).toBe('function');
    });

    describe('onSet handler behavior', () => {
        const setup = ({ throwOnCall }: { throwOnCall?: boolean } = {}) => {
            const { component, raw, turnOn, turnOff } = createFakeSwitchComponent({ throwOnCall });
            const { accessory } = createFakeAccessory();

            switchHelper(component, accessory, createFakeApi());

            const service = accessory.services[0] as unknown as FakeSwitchService;
            const setHandler = service.getCharacteristic(ON_CHARACTERISTIC_KEY)!.setHandler!;
            return { component, raw, turnOn, turnOff, setHandler, accessory };
        };

        it('turns the component on for truthy values when currently off', async () => {
            const { turnOn, turnOff, setHandler, raw } = setup();
            await setHandler(true);
            expect(raw.status).toBe(false); // remote state is unchanged by the handler itself
            expect(turnOn).toHaveBeenCalledTimes(1);
            expect(turnOff).not.toHaveBeenCalled();
        });

        it('turns the component off for falsy values when currently on', async () => {
            const { turnOn, turnOff, setHandler, raw } = setup();
            raw.status = true;
            await setHandler(false);
            expect(turnOff).toHaveBeenCalledTimes(1);
            expect(turnOn).not.toHaveBeenCalled();
        });

        it('is a no-op when the component already has the requested state', async () => {
            const { turnOn, turnOff, setHandler, raw } = setup();
            raw.status = false;
            await setHandler(false);
            expect(turnOn).not.toHaveBeenCalled();
            expect(turnOff).not.toHaveBeenCalled();

            raw.status = true;
            await setHandler(true);
            expect(turnOn).not.toHaveBeenCalled();
            expect(turnOff).not.toHaveBeenCalled();
        });

        it('throws a HapStatusError with SERVICE_COMMUNICATION_FAILURE when the device write fails', async () => {
            const { setHandler, turnOn } = setup({ throwOnCall: true });
            turnOn.mockImplementation(() => {
                throw new Error('device gone');
            });
            await expect(setHandler(true)).rejects.toThrow(FakeHapStatusError);
        });

        it('treats truthy non-boolean values the same as true', async () => {
            const { turnOn, turnOff, setHandler } = setup();
            await setHandler(100 as unknown as CharacteristicValue);
            expect(turnOn).toHaveBeenCalledTimes(1);
            expect(turnOff).not.toHaveBeenCalled();
        });
    });

    describe('state$ subscription lifecycle', () => {
        it('stays subscribed after the helper returns and pushes remote state with setValue', () => {
            const { component, raw, state$ } = createFakeSwitchComponent();
            const { accessory } = createFakeAccessory();

            switchHelper(component, accessory, createFakeApi());

            const service = accessory.services[0] as unknown as FakeSwitchService;
            const onCharacteristic = service.getCharacteristic(ON_CHARACTERISTIC_KEY)!;

            raw.status = true;
            state$.next({});
            expect(onCharacteristic.value).toBe(true);

            raw.status = false;
            state$.next({});
            expect(onCharacteristic.value).toBe(false);
        });
    });
});
