import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { API, CharacteristicValue, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { BehaviorSubject, Subject, type Observable } from 'rxjs';
// The class below is the *mocked* InvalidPasswordError from the vi.mock('esphome-ts') factory;
// importing it via the same specifier hands back the mock class for instanceof-friendly emission.
import { InvalidPasswordError } from 'esphome-ts';
import { EsphomePlatform } from './platform.js';

/**
 * Cross-scope registry shared with the vi.mock factories (vi.mock factories are hoisted above
 * imports, so their factories may only reach variables defined via vi.hoisted).
 */
const registry = vi.hoisted(() => ({
    espDevices: [] as unknown[],
    /** component-type -> component helper; absent type => `get` yields undefined. */
    helperMap: new Map<string, unknown>(),
}));

vi.mock('esphome-ts', () => {
    class MockInvalidPasswordError extends Error {}

    class MockEspDevice {
        public readonly error$ = new Subject<Error>();
        public readonly discovery$ = new Subject<boolean>();
        // Faithful to esphome-ts v5: alive$ merges socket.connected$, which is a
        // BehaviorSubject(false) (dist/index.js:2499), and is buffered/piped with
        // distinctUntilChanged + shareReplay({ bufferSize: 1, refCount: true })
        // (dist/index.js:3351-3359) — every subscriber synchronously receives the buffered
        // false at subscribe time.
        public readonly alive$ = new BehaviorSubject<boolean>(false);
        public readonly components: Record<string, { name: string; type: string }> = {};
        public readonly provideRetryObservable = vi.fn();
        public readonly terminate = vi.fn();

        public constructor(
            public readonly host: string,
            public readonly password?: string,
            public readonly port?: number,
        ) {
            registry.espDevices.push(this);
        }
    }

    return { EspDevice: MockEspDevice, InvalidPasswordError: MockInvalidPasswordError };
});

// The registry mock exposes only `get`, mirroring the `componentHelpers.get(component.type)`
// call the platform makes. A mapped component is registered as a *function* — truthy under the
// older boolean-registry contract AND a teardown-producing helper under the current contract,
// keeping the spec honest under both. An unmapped component is simply absent from the map, so
// `get` returns undefined. A helper whose *invocation* returns undefined produces the
// "could not be mapped" branch; one returning a teardown produces the success path.
const setupComponentHelper = (type: string, helper: Mock) => {
    registry.helperMap.set(type, helper);
};

vi.mock('./homebridgeAccessories/componentHelpers.js', () => ({
    componentHelpers: {
        get: (type: unknown) => registry.helperMap.get(type as string),
    },
}));

/* ------------------------------------------------------------------ *
 * Inline hap fakes — minimal faithful copies of the technique used in
 * src/testing/hapFakes.ts, self-contained so the platform spec stays
 * independent of that (newer) harness.
 * ------------------------------------------------------------------ */

type FakeSetHandler = (value: CharacteristicValue) => unknown;
type FakeGetHandler = () => unknown;

interface FakeCharacteristic {
    readonly UUID: string;
    value: CharacteristicValue | undefined;
    setHandler: FakeSetHandler | undefined;
    getHandler: FakeGetHandler | undefined;
    onSet(handler: FakeSetHandler): FakeCharacteristic;
    onGet(handler: FakeGetHandler): FakeCharacteristic;
    setValue(value: CharacteristicValue): void;
    updateValue(value: CharacteristicValue): void;
}

interface FakeCharacteristicConstructor {
    readonly UUID: string;
    new (): FakeCharacteristic;
}

interface FakeService {
    readonly UUID: string;
    readonly characteristics: Map<string, FakeCharacteristic>;
    readonly optionalCharacteristics: Array<{ readonly UUID: string }>;
    /** Missing characteristic auto-added via getCharacteristic while listed as optional. */
    readonly autoAddedCharacteristics: FakeCharacteristic[];
    /** Missing characteristic auto-added via getCharacteristic while NOT listed (warn in real hap). */
    readonly warnedAutoAdds: FakeCharacteristic[];
    testCharacteristic(constructor: FakeCharacteristicConstructor): boolean;
    getCharacteristic(constructor: FakeCharacteristicConstructor): FakeCharacteristic;
    addCharacteristic(characteristic: FakeCharacteristic): FakeCharacteristic;
}

/**
 * Faithful to real hap-nodejs: `setValue` stores the value and re-enters a registered `onSet`
 * handler (swallowing synchronous throws, like real hap without a backing callback);
 * `updateValue` only stores the value and never re-enters `onSet`.
 */
const makeFakeCharacteristicClass = (uuid: string): FakeCharacteristicConstructor => {
    class FakeCharacteristic implements FakeCharacteristic {
        public static readonly UUID = uuid;
        public readonly UUID = uuid;
        public value: CharacteristicValue | undefined;
        public setHandler: FakeSetHandler | undefined;
        public getHandler: FakeGetHandler | undefined;

        public onSet(handler: FakeSetHandler): FakeCharacteristic {
            this.setHandler = handler;
            return this;
        }

        public onGet(handler: FakeGetHandler): FakeCharacteristic {
            this.getHandler = handler;
            return this;
        }

        public setValue(value: CharacteristicValue): void {
            this.value = value;
            const handler = this.setHandler;
            if (!handler) {
                return;
            }
            try {
                void Promise.resolve(handler(value)).catch(() => undefined);
            } catch {
                // Swallowed like real hap.
            }
        }

        public updateValue(value: CharacteristicValue): void {
            this.value = value;
        }
    }
    return FakeCharacteristic;
};

/**
 * Faithful service double: silent instance-form `addCharacteristic`; `testCharacteristic` is a
 * pure existence check; `getCharacteristic` always returns a characteristic (auto-adding when
 * missing), tracking whether the add was optional-listed (silent) or unlisted (warned in real hap).
 */
const makeFakeServiceClass = (uuid: string): { new (name?: string): FakeService } & { UUID: string } => {
    class FakeService implements FakeService {
        public static readonly UUID = uuid;
        public readonly UUID = uuid;
        public readonly name: string;
        public readonly characteristics = new Map<string, FakeCharacteristic>();
        public readonly optionalCharacteristics: Array<{ readonly UUID: string }> = [];
        public readonly autoAddedCharacteristics: FakeCharacteristic[] = [];
        public readonly warnedAutoAdds: FakeCharacteristic[] = [];

        public constructor(name = '') {
            this.name = name;
        }

        public testCharacteristic(constructor: FakeCharacteristicConstructor): boolean {
            return this.characteristics.has(constructor.UUID);
        }

        public getCharacteristic(constructor: FakeCharacteristicConstructor): FakeCharacteristic {
            const existing = this.characteristics.get(constructor.UUID);
            if (existing) {
                return existing;
            }
            const created = new constructor();
            this.characteristics.set(created.UUID, created);
            if (this.optionalCharacteristics.some((option) => option.UUID === created.UUID)) {
                this.autoAddedCharacteristics.push(created);
            } else {
                this.warnedAutoAdds.push(created);
            }
            return created;
        }

        public addCharacteristic(characteristic: FakeCharacteristic): FakeCharacteristic {
            this.characteristics.set(characteristic.UUID, characteristic);
            return characteristic;
        }
    }
    return FakeService;
};

const StatusActiveCharacteristic = makeFakeCharacteristicClass('status-active-uuid');
const AccessoryInformationService = makeFakeServiceClass('accessory-information-uuid');
const SensorService = makeFakeServiceClass('sensor-service-uuid');

class FakePlatformAccessory {
    public readonly displayName: string;
    public readonly UUID: string;
    public readonly services: FakeService[] = [];
    /** Mirrors the real accessory context bag: an untyped record persisted to disk. */
    public readonly context: Record<string, unknown> = {};

    public constructor(displayName: string, uuid: string) {
        this.displayName = displayName;
        this.UUID = uuid;
    }

    public addService(service: FakeService): FakeService {
        this.services.push(service);
        return service;
    }
}

interface PrivatePlatformState {
    accessories: FakePlatformAccessory[];
    accessoriesByHost: Map<string, FakePlatformAccessory[]>;
    aliveStateByHost: Map<string, boolean>;
    config: { devices?: unknown[] };
}

const internals = (platform: EsphomePlatform): PrivatePlatformState => platform as unknown as PrivatePlatformState;

/** Shape of the mocked EspDevice instance the platform exercised, as the spec sees it. */
interface MockEspDeviceInstance {
    readonly host: string;
    readonly password: string | undefined;
    readonly port: number | undefined;
    readonly error$: { next: (error: Error) => void };
    readonly discovery$: { next: (discovered: boolean) => void };
    readonly alive$: { next: (alive: boolean) => void };
    readonly components: Record<string, { name: string; type: string }>;
    readonly provideRetryObservable: Mock;
    readonly terminate: Mock;
}

const espDeviceAt = (index: number) => registry.espDevices[index] as unknown as MockEspDeviceInstance;

const registeredAccessory = (registerPlatformAccessories: Mock): FakePlatformAccessory =>
    registerPlatformAccessories.mock.calls[0]?.[2]?.[0] as FakePlatformAccessory;

const createFakeLogging = () => {
    const base = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const debug = vi.fn();
    const log = Object.assign(base, { info, warn, error, debug }) as unknown as Logging;
    return { log, base, info, warn, error, debug };
};

const createFakeApi = () => {
    const callbacks = new Map<string, Array<(...args: unknown[]) => void>>();
    const on = vi.fn((event: string, callback: (...args: unknown[]) => void) => {
        callbacks.set(event, [...(callbacks.get(event) ?? []), callback]);
    });
    const registerPlatformAccessories = vi.fn();
    const unregisterPlatformAccessories = vi.fn();
    const api = {
        on,
        hap: {
            uuid: { generate: (name: string) => `uuid-${name}` },
            Service: { AccessoryInformation: AccessoryInformationService },
            Characteristic: { StatusActive: StatusActiveCharacteristic },
        },
        platformAccessory: FakePlatformAccessory,
        registerPlatformAccessories,
        unregisterPlatformAccessories,
    } as unknown as API;
    const didFinishLaunching = () => callbacks.get('didFinishLaunching')?.forEach((callback) => callback());
    const shutdown = () => callbacks.get('shutdown')?.forEach((callback) => callback());
    return { api, on, registerPlatformAccessories, unregisterPlatformAccessories, didFinishLaunching, shutdown };
};

interface PlatformSetupOptions {
    devices?: Array<{ host: string; password?: string; port?: number; retryAfter?: number }>;
    blacklist?: string[];
    debug?: boolean;
}

const createPlatform = (options: PlatformSetupOptions = {}) => {
    const logSpies = createFakeLogging();
    const apiSpies = createFakeApi();
    const config = {
        blacklist: [],
        ...options,
    } as unknown as PlatformConfig;
    const platform = new EsphomePlatform(logSpies.log, config, apiSpies.api);
    return { platform, config, ...logSpies, ...apiSpies };
};

const addComponent = (device: MockEspDeviceInstance, name: string, type: string): void => {
    device.components[type] = { name, type };
};

beforeEach(() => {
    registry.espDevices.length = 0;
    registry.helperMap.clear();
});

describe('EsphomePlatform', () => {
    it('logs "starting esphome" and registers the lifecycle callbacks via api.on', () => {
        const { base, on } = createPlatform();

        expect(base).toHaveBeenCalledWith('starting esphome');
        expect(on).toHaveBeenCalledWith('didFinishLaunching', expect.anything());
        expect(on).toHaveBeenCalledWith('shutdown', expect.anything());
    });

    it('logs an error and empties the devices array when neither devices nor discovery are configured', () => {
        const { platform, error } = createPlatform();

        expect(error).toHaveBeenCalledWith(expect.stringContaining('did not specify a devices array'));
        expect(internals(platform).config.devices).toEqual([]);
    });

    it('constructs an EspDevice from config and persists the host on a mapped component accessory', () => {
        const helper = vi.fn(() => () => {});
        setupComponentHelper('light', helper);
        const { registerPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', password: 'secret', port: 6053 }],
        });
        didFinishLaunching();

        expect(registry.espDevices).toHaveLength(1);
        const device = espDeviceAt(0);
        expect(device.host).toBe('esp-one.local');
        expect(device.password).toBe('secret');
        expect(device.port).toBe(6053);
        expect(device.provideRetryObservable).toHaveBeenCalledTimes(1);

        addComponent(device, 'office-light', 'light');
        device.discovery$.next(true);

        expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
        const accessory = registeredAccessory(registerPlatformAccessories);
        expect(accessory.UUID).toBe('uuid-office-light');
        // H7: host persisted on the accessory so a cached accessory re-associates on restore.
        expect(accessory.context.host).toBe('esp-one.local');
        expect(helper).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'office-light' }),
            accessory,
            expect.anything(),
        );
    });

    it('skips blacklisted components without calling the component helper', () => {
        const helper = vi.fn(() => () => {});
        setupComponentHelper('light', helper);
        const { registerPlatformAccessories, unregisterPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
            blacklist: ['office-light'],
        });
        didFinishLaunching();
        const device = espDeviceAt(0);
        addComponent(device, 'office-light', 'light');
        device.discovery$.next(true);

        expect(helper).not.toHaveBeenCalled();
        expect(registerPlatformAccessories).not.toHaveBeenCalled();
        expect(unregisterPlatformAccessories).not.toHaveBeenCalled();
    });

    it('logs "not supported" for unknown component types without registering', () => {
        const { base, registerPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
        });
        didFinishLaunching();
        addComponent(espDeviceAt(0), 'roomba', 'vacuum');
        espDeviceAt(0).discovery$.next(true);

        expect(base).toHaveBeenCalledWith(expect.stringContaining('currently not supported'));
        expect(registerPlatformAccessories).not.toHaveBeenCalled();
    });

    it('does not register a brand-new accessory when the helper yields no teardown', () => {
        // Helper itself truthy, its invocation returns undefined: `() => undefined`.
        setupComponentHelper(
            'light',
            vi.fn(() => undefined),
        );
        const { base, registerPlatformAccessories, unregisterPlatformAccessories, didFinishLaunching } = createPlatform(
            { devices: [{ host: 'esp-one.local' }] },
        );
        didFinishLaunching();
        addComponent(espDeviceAt(0), 'office-light', 'light');
        espDeviceAt(0).discovery$.next(true);

        expect(base).toHaveBeenCalledWith(expect.stringContaining('could not be mapped'));
        // Brand-new accessory: nothing was registered, so nothing may be unregistered either.
        expect(registerPlatformAccessories).not.toHaveBeenCalled();
        expect(unregisterPlatformAccessories).not.toHaveBeenCalled();
    });

    it('unregisters a pre-existing accessory when the helper yields no teardown', () => {
        setupComponentHelper(
            'light',
            vi.fn(() => undefined),
        );
        const { platform, unregisterPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
        });
        const existing = new FakePlatformAccessory('office-light', 'uuid-office-light');
        platform.configureAccessory(existing as unknown as PlatformAccessory);
        didFinishLaunching();
        addComponent(espDeviceAt(0), 'office-light', 'light');
        espDeviceAt(0).discovery$.next(true);

        expect(unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
        expect(unregisterPlatformAccessories.mock.calls[0][2][0]).toBe(existing);
        expect(internals(platform).accessories).toHaveLength(1); // the cached push, minus nothing new
    });

    it('names the host and password config on InvalidPasswordError and debugs other errors', () => {
        const { error, debug, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local', password: 'secret' }],
        });
        didFinishLaunching();
        const device = espDeviceAt(0);

        device.error$.next(new InvalidPasswordError('esp-one.local'));
        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('esp-one.local'));
        expect(error).toHaveBeenCalledWith(expect.stringContaining('rejected your password'));

        device.error$.next(new Error('boom'));
        expect(debug).toHaveBeenCalledWith(expect.stringContaining('esp-one.local'), expect.anything());
        expect(error).toHaveBeenCalledTimes(1); // plain errors never go to the error log
    });

    it('stops the retry cadence when the device rejects the password', () => {
        // esphome-ts 5 latches an InvalidPasswordError as terminal, so the retry cadence the
        // platform provides must complete instead of ticking futile reconnect logs forever.
        vi.useFakeTimers();
        try {
            const { info, didFinishLaunching } = createPlatform({
                devices: [{ host: 'esp-one.local', password: 'secret', retryAfter: 1000 }],
            });
            didFinishLaunching();
            const device = espDeviceAt(0);
            const retry$ = device.provideRetryObservable.mock.calls[0]?.[0] as Observable<unknown>;
            const emissions: unknown[] = [];
            const subscription = retry$.subscribe((value) => emissions.push(value));

            vi.advanceTimersByTime(2000);
            expect(emissions).toHaveLength(2);
            expect(info).toHaveBeenCalledWith(expect.stringContaining('Trying to reconnect'));

            device.error$.next(new InvalidPasswordError('esp-one.local'));
            expect(subscription.closed).toBe(true);

            vi.advanceTimersByTime(5000);
            expect(emissions).toHaveLength(2); // the latch keeps the cadence stopped
        } finally {
            vi.useRealTimers();
        }
    });

    it('syncs the last known connection state into freshly added accessories', () => {
        setupComponentHelper(
            'light',
            vi.fn(() => () => {}),
        );
        const { registerPlatformAccessories, didFinishLaunching } = createPlatform({
            // Two configured entries for the same host make onHomebridgeDidFinishLaunching run
            // addAccessories twice for it (the second run is the "subsequent" one).
            devices: [{ host: 'esp-one.local' }, { host: 'esp-one.local' }],
        });
        didFinishLaunching();
        const firstDevice = espDeviceAt(0);
        const secondDevice = espDeviceAt(1);

        addComponent(firstDevice, 'office-light', 'light');
        firstDevice.discovery$.next(true);
        const accessory = registeredAccessory(registerPlatformAccessories);
        const sensorService = new SensorService();
        accessory.addService(sensorService);

        firstDevice.alive$.next(false); // watchDeviceConnection records the offline state for the host
        addComponent(secondDevice, 'office-light', 'light');
        secondDevice.discovery$.next(true); // subsequent addAccessories run

        // The service only got its characteristic through the fresh-accessory sync path.
        expect(sensorService.testCharacteristic(StatusActiveCharacteristic)).toBe(true);
        expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(false);

        secondDevice.alive$.next(true);
        expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(true);
    });

    it('re-associates cached accessories with their persisted host for status sync', () => {
        const { platform, registerPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local' }],
        });
        const cached = new FakePlatformAccessory('cached-component', 'uuid-cached-component');
        const sensorService = new SensorService();
        cached.addService(sensorService);
        cached.context.host = 'esp-one.local';
        platform.configureAccessory(cached as unknown as PlatformAccessory);

        expect(internals(platform).accessories).toHaveLength(1);
        expect(registerPlatformAccessories).not.toHaveBeenCalled();

        didFinishLaunching();
        // No component discovery at all — the status write proves the cached accessory is
        // re-associated via context.host.
        espDeviceAt(0).alive$.next(true);
        expect(sensorService.testCharacteristic(StatusActiveCharacteristic)).toBe(true);
        expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(true);
    });

    it('associates nothing for cached accessories from older disk caches without context.host', () => {
        const { platform, didFinishLaunching } = createPlatform({ devices: [{ host: 'esp-one.local' }] });
        const cached = new FakePlatformAccessory('old-cached-component', 'uuid-old-cached');
        const sensorService = new SensorService();
        cached.addService(sensorService);
        platform.configureAccessory(cached as unknown as PlatformAccessory);

        didFinishLaunching();
        espDeviceAt(0).alive$.next(true);
        expect(sensorService.testCharacteristic(StatusActiveCharacteristic)).toBe(false);
    });

    it('unregisters blacklisted cached accessories', () => {
        const { platform, unregisterPlatformAccessories } = createPlatform({ blacklist: ['forbidden'] });
        const cached = new FakePlatformAccessory('forbidden', 'uuid-forbidden');
        platform.configureAccessory(cached as unknown as PlatformAccessory);

        expect(unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
        expect(unregisterPlatformAccessories.mock.calls[0][2][0]).toBe(cached);
        expect(internals(platform).accessories).toHaveLength(0);
    });

    it('guards against duplicate associations for the same host and component', () => {
        setupComponentHelper(
            'light',
            vi.fn(() => () => {}),
        );
        const { platform, registerPlatformAccessories, didFinishLaunching } = createPlatform({
            devices: [{ host: 'esp-one.local' }, { host: 'esp-one.local' }],
        });
        didFinishLaunching();
        const firstDevice = espDeviceAt(0);
        const secondDevice = espDeviceAt(1);

        addComponent(firstDevice, 'office-light', 'light');
        firstDevice.discovery$.next(true); // new accessory: registered once
        addComponent(secondDevice, 'office-light', 'light');
        secondDevice.discovery$.next(true); // existing accessory: reused

        expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
        const state = internals(platform);
        expect(state.accessories).toHaveLength(1);
        expect(state.accessoriesByHost.get('esp-one.local')).toHaveLength(1);

        // configureAccessory twice does not double-push either.
        const cached = new FakePlatformAccessory('cached-component', 'uuid-cached-component');
        cached.context.host = 'esp-one.local';
        platform.configureAccessory(cached as unknown as PlatformAccessory);
        platform.configureAccessory(cached as unknown as PlatformAccessory);
        expect(state.accessories).toHaveLength(2);
        expect(state.accessoriesByHost.get('esp-one.local')).toHaveLength(2);
    });

    it('terminates every device and drops later error emissions after shutdown', () => {
        const { error, didFinishLaunching, shutdown } = createPlatform({
            devices: [{ host: 'esp-one.local' }, { host: 'esp-two.local' }],
        });
        didFinishLaunching();

        shutdown();
        expect(espDeviceAt(0).terminate).toHaveBeenCalledTimes(1);
        expect(espDeviceAt(1).terminate).toHaveBeenCalledTimes(1);

        espDeviceAt(0).error$.next(new Error('late emission'));
        espDeviceAt(0).error$.next(new InvalidPasswordError('esp-one.local'));
        expect(error).not.toHaveBeenCalled(); // subscription unsubscribed: no logging anymore
    });
});
