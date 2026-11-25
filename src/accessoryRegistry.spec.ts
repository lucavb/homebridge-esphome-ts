import { describe, expect, it, vi } from 'vitest';
import type { API, Logging, PlatformAccessory, Service } from 'homebridge';
import type { BaseComponent, ComponentType } from 'esphome-ts';

import { createAccessoryRegistry } from './accessoryRegistry.js';
import type { ResolvedDeviceConfig } from './deviceConfig.js';
import type { ComponentHelper } from './homebridgeAccessories/componentHelpers.js';
import { asComponent } from './testing/fakeEspDevice.js';
import { createFakeDeviceSession } from './testing/fakeDeviceSession.js';
import { FakePlatformAccessory, makeFakeCharacteristicClass, makeFakeServiceClass } from './testing/hapFakes.js';

const StatusActiveCharacteristic = makeFakeCharacteristicClass('status-active-uuid');
const AccessoryInformationService = makeFakeServiceClass('accessory-information-uuid');
const SensorService = makeFakeServiceClass('sensor-service-uuid');

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
    const registerPlatformAccessories = vi.fn();
    const unregisterPlatformAccessories = vi.fn();
    const api = {
        hap: {
            uuid: { generate: (name: string) => `uuid-${name}` },
            Service: { AccessoryInformation: AccessoryInformationService },
            Characteristic: { StatusActive: StatusActiveCharacteristic },
        },
        platformAccessory: FakePlatformAccessory,
        registerPlatformAccessories,
        unregisterPlatformAccessories,
    } as unknown as API;
    return { api, registerPlatformAccessories, unregisterPlatformAccessories };
};

const okHelper: ComponentHelper = () => () => {};

const helperTable = (entries: Array<[ComponentType, ComponentHelper]>): ReadonlyMap<ComponentType, ComponentHelper> =>
    new Map(entries);

interface RegistrySetupOptions {
    blacklist?: string[];
    debug?: boolean;
    helpers?: ReadonlyMap<ComponentType, ComponentHelper>;
}

const createRegistry = (options: RegistrySetupOptions = {}) => {
    const logging = createFakeLogging();
    const apiSpies = createFakeApi();
    const registry = createAccessoryRegistry({
        api: apiSpies.api,
        log: logging.log,
        blacklist: new Set(options.blacklist ?? []),
        debug: options.debug ?? false,
        helpers: options.helpers ?? helperTable([['light', vi.fn(okHelper)]]),
    });
    return { registry, ...logging, ...apiSpies };
};

const resolvedDevice = (overrides: Partial<ResolvedDeviceConfig> = {}): ResolvedDeviceConfig => ({
    host: 'esp-one.local',
    retryAfter: 90_000,
    invertFanDirection: false,
    ...overrides,
});

const light = (name = 'office-light'): BaseComponent => asComponent({ name, type: 'light' });

const registeredAccessory = (registerPlatformAccessories: ReturnType<typeof vi.fn>): FakePlatformAccessory =>
    registerPlatformAccessories.mock.calls[0]?.[2]?.[0] as FakePlatformAccessory;

const unregisteredAccessories = (unregisterPlatformAccessories: ReturnType<typeof vi.fn>): unknown[] =>
    unregisterPlatformAccessories.mock.calls[0]?.[2] as unknown[];

describe('createAccessoryRegistry', () => {
    describe('bind', () => {
        it('creates, binds, registers, and records the host of a new Accessory', () => {
            const helper = vi.fn(okHelper);
            const { registry, registerPlatformAccessories, base } = createRegistry({
                helpers: helperTable([['light', helper]]),
            });
            const session = createFakeDeviceSession();
            const component = light();

            registry.bind(resolvedDevice({ invertFanDirection: true }), session.session);
            session.emitComponents([component]);

            expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
            const accessory = registeredAccessory(registerPlatformAccessories);
            expect(accessory).toBeInstanceOf(FakePlatformAccessory);
            expect(accessory.displayName).toBe('office-light');
            expect(accessory.UUID).toBe('uuid-office-light');
            expect(accessory.context.host).toBe('esp-one.local');
            expect(helper).toHaveBeenCalledWith(component, accessory, expect.anything(), {
                invertFanDirection: true,
            });
            expect(base).toHaveBeenCalledWith('office-light discovered and setup.');
        });

        it('skips a blacklisted Component without calling the helper', () => {
            const helper = vi.fn(okHelper);
            const { registry, registerPlatformAccessories, debug } = createRegistry({
                blacklist: ['office-light'],
                helpers: helperTable([['light', helper]]),
            });
            const session = createFakeDeviceSession();
            registry.bind(resolvedDevice(), session.session);

            session.emitComponents([light()]);

            expect(helper).not.toHaveBeenCalled();
            expect(registerPlatformAccessories).not.toHaveBeenCalled();
            expect(debug).toHaveBeenCalledWith(
                expect.stringContaining('because it was blacklisted'),
                expect.anything(),
            );
        });

        it('logs an unsupported Component type and registers nothing', () => {
            const { registry, registerPlatformAccessories, base } = createRegistry();
            const session = createFakeDeviceSession();
            registry.bind(resolvedDevice(), session.session);

            session.emitComponents([asComponent({ name: 'roomba', type: 'vacuum' })]);

            expect(base).toHaveBeenCalledWith(expect.stringContaining('currently not supported'));
            expect(registerPlatformAccessories).not.toHaveBeenCalled();
        });

        it('logs and does not register when a new Component cannot be mapped', () => {
            const helper = vi.fn((): ReturnType<ComponentHelper> => undefined);
            const { registry, registerPlatformAccessories, unregisterPlatformAccessories, base } = createRegistry({
                helpers: helperTable([['light', helper]]),
            });
            const session = createFakeDeviceSession();
            registry.bind(resolvedDevice(), session.session);

            session.emitComponents([light()]);

            expect(base).toHaveBeenCalledWith(expect.stringContaining('could not be mapped'));
            expect(registerPlatformAccessories).not.toHaveBeenCalled();
            expect(unregisterPlatformAccessories).not.toHaveBeenCalled();
        });

        it('unregisters a pre-existing Accessory and runs its teardowns when it can no longer be mapped', () => {
            const teardown = vi.fn();
            const helper = vi.fn(okHelper).mockReturnValueOnce(teardown).mockReturnValueOnce(undefined);
            const { registry, registerPlatformAccessories, unregisterPlatformAccessories } = createRegistry({
                helpers: helperTable([['light', helper]]),
            });
            const device = resolvedDevice();
            const first = createFakeDeviceSession();
            registry.bind(device, first.session);
            first.emitComponents([light()]);
            const accessory = registeredAccessory(registerPlatformAccessories);

            const second = createFakeDeviceSession();
            registry.bind(device, second.session);
            second.emitComponents([light()]);

            expect(unregisteredAccessories(unregisterPlatformAccessories)).toEqual([accessory]);
            expect(teardown).toHaveBeenCalledTimes(1);
            expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
        });

        it('keeps the other Devices streaming when a helper throws', () => {
            const broken: ComponentHelper = () => {
                throw new Error('component setup failed');
            };
            const lightHelper = vi.fn(okHelper);
            const { registry, registerPlatformAccessories, error } = createRegistry({
                helpers: helperTable([
                    ['sensor', broken],
                    ['light', lightHelper],
                ]),
            });
            const first = createFakeDeviceSession();
            const second = createFakeDeviceSession();
            registry.bind(resolvedDevice({ host: 'esp-one.local' }), first.session);
            registry.bind(resolvedDevice({ host: 'esp-two.local' }), second.session);

            first.emitComponents([asComponent({ name: 'broken-component', type: 'sensor' })]);
            second.emitComponents([light()]);

            expect(error).toHaveBeenCalledWith(
                expect.stringContaining('Error while discovering or setting up accessories for device esp-one.local.'),
                expect.any(Error),
            );
            expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
        });

        it('catches a freshly added Accessory up with the last known Connection status', () => {
            const addSensor: ComponentHelper = (...args) => {
                args[1].addService(new SensorService() as unknown as Service);
                return () => {};
            };
            const { registry, registerPlatformAccessories } = createRegistry({
                helpers: helperTable([['light', addSensor]]),
            });
            const session = createFakeDeviceSession();
            registry.bind(resolvedDevice(), session.session);

            session.emitComponents([light()]);

            const accessory = registeredAccessory(registerPlatformAccessories);
            const [sensorService] = accessory.services;
            expect(sensorService.testCharacteristic(StatusActiveCharacteristic)).toBe(true);
            expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(false);

            session.emitAlive(true);
            expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(true);
        });
    });

    describe('identity', () => {
        it('keeps the first Device when a second Device claims a same-named Component', () => {
            const helper = vi.fn(okHelper);
            const { registry, registerPlatformAccessories, error } = createRegistry({
                helpers: helperTable([['light', helper]]),
            });
            const first = createFakeDeviceSession();
            const second = createFakeDeviceSession();
            registry.bind(resolvedDevice({ host: 'esp-one.local' }), first.session);
            registry.bind(resolvedDevice({ host: 'esp-two.local' }), second.session);

            first.emitComponents([light()]);
            second.emitComponents([light()]);

            expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
            expect(helper).toHaveBeenCalledTimes(1);
            expect(error).toHaveBeenCalledWith(expect.stringContaining('Both esp-one.local and esp-two.local'));
            expect(error).toHaveBeenCalledWith(expect.stringContaining('"office-light"'));
            // The survivor is the first Device's binding; UUID and name alone cannot tell them apart.
            expect(registeredAccessory(registerPlatformAccessories).context.host).toBe('esp-one.local');
        });

        it("still binds the second Device's other Components after refusing the collision", () => {
            const helper = vi.fn(okHelper);
            const { registry, registerPlatformAccessories } = createRegistry({
                helpers: helperTable([['light', helper]]),
            });
            const first = createFakeDeviceSession();
            const second = createFakeDeviceSession();
            registry.bind(resolvedDevice({ host: 'esp-one.local' }), first.session);
            registry.bind(resolvedDevice({ host: 'esp-two.local' }), second.session);

            first.emitComponents([light()]);
            second.emitComponents([light(), light('office-fan')]);

            expect(registerPlatformAccessories).toHaveBeenCalledTimes(2);
            expect(helper).toHaveBeenCalledTimes(2);
        });

        it('does not treat a repeated claim from the same Device host as a collision', () => {
            const helper = vi.fn(okHelper);
            const { registry, error } = createRegistry({ helpers: helperTable([['light', helper]]) });
            const device = resolvedDevice();
            const first = createFakeDeviceSession();
            const second = createFakeDeviceSession();
            registry.bind(device, first.session);
            registry.bind(device, second.session);

            first.emitComponents([light()]);
            second.emitComponents([light()]);

            expect(error).not.toHaveBeenCalled();
            expect(helper).toHaveBeenCalledTimes(2);
        });

        it('releases the claim when the owning Accessory is unregistered', () => {
            const teardown = vi.fn();
            const helper = vi
                .fn(okHelper)
                .mockReturnValueOnce(teardown)
                .mockReturnValueOnce(undefined)
                .mockReturnValueOnce(() => {});
            const { registry, registerPlatformAccessories, unregisterPlatformAccessories } = createRegistry({
                helpers: helperTable([['light', helper]]),
            });
            const firstOwner = createFakeDeviceSession();
            const claimant = createFakeDeviceSession();
            registry.bind(resolvedDevice({ host: 'esp-one.local' }), firstOwner.session);
            registry.bind(resolvedDevice({ host: 'esp-two.local' }), claimant.session);
            firstOwner.emitComponents([light()]);
            claimant.emitComponents([light()]);
            expect(helper).toHaveBeenCalledTimes(1);

            const rebind = createFakeDeviceSession();
            registry.bind(resolvedDevice({ host: 'esp-one.local' }), rebind.session);
            rebind.emitComponents([light()]);
            expect(unregisteredAccessories(unregisterPlatformAccessories)).toHaveLength(1);

            const retry = createFakeDeviceSession();
            registry.bind(resolvedDevice({ host: 'esp-two.local' }), retry.session);
            retry.emitComponents([light()]);

            expect(registerPlatformAccessories).toHaveBeenCalledTimes(2);
        });

        it('lets only the claiming Device drive Connection status of a cached Accessory', () => {
            const addSensor: ComponentHelper = (...args) => {
                args[1].addService(new SensorService() as unknown as Service);
                return () => {};
            };
            const { registry, registerPlatformAccessories, unregisterPlatformAccessories, error } = createRegistry({
                helpers: helperTable([['light', addSensor]]),
            });
            const cached = new FakePlatformAccessory('office-light', 'uuid-office-light');
            cached.context.host = 'esp-one.local';
            const sensorService = new SensorService();
            cached.addService(sensorService);
            registry.restore(cached as unknown as PlatformAccessory);
            // A second cached Accessory on an unrelated host proves the re-association drops
            // only the moved Accessory, not every host's list.
            const unrelated = new FakePlatformAccessory('hall-sensor', 'uuid-hall-sensor');
            unrelated.context.host = 'esp-three.local';
            const hallService = new SensorService();
            unrelated.addService(hallService);
            registry.restore(unrelated as unknown as PlatformAccessory);
            const first = createFakeDeviceSession();
            const second = createFakeDeviceSession();
            const third = createFakeDeviceSession();
            registry.bind(resolvedDevice({ host: 'esp-one.local' }), first.session);
            registry.bind(resolvedDevice({ host: 'esp-two.local' }), second.session);
            registry.bind(resolvedDevice({ host: 'esp-three.local' }), third.session);

            // The second Device wins the claim: its Components arrive first.
            second.emitComponents([light()]);
            first.emitComponents([light()]);
            // The winner is named first, so the losing Device appears second in the message.
            expect(error).toHaveBeenCalledWith(expect.stringContaining('Both esp-two.local and esp-one.local'));

            const status = sensorService.getCharacteristic(StatusActiveCharacteristic);
            second.emitAlive(true);
            expect(status.value).toBe(true);

            // The unrelated host keeps its association and its Connection status.
            third.emitAlive(true);
            expect(hallService.getCharacteristic(StatusActiveCharacteristic).value).toBe(true);

            // The losing Device's transport state must no longer reach the Accessory.
            first.emitAlive(true);
            first.emitAlive(false);
            expect(status.value).toBe(true);
            expect(cached.context.host).toBe('esp-two.local');
            expect(registerPlatformAccessories).not.toHaveBeenCalled();
            expect(unregisterPlatformAccessories).not.toHaveBeenCalled();
        });
    });

    describe('Connection status', () => {
        it('syncs a restored Accessory when its Device session binds and when alive changes', () => {
            const { registry } = createRegistry();
            const accessory = new FakePlatformAccessory('cached-component', 'uuid-cached-component');
            accessory.context.host = 'esp-one.local';
            const sensorService = new SensorService();
            accessory.addService(sensorService);
            registry.restore(accessory as unknown as PlatformAccessory);
            const session = createFakeDeviceSession();

            registry.bind(resolvedDevice(), session.session);

            expect(sensorService.testCharacteristic(StatusActiveCharacteristic)).toBe(true);
            expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(false);

            session.emitAlive(true);
            expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(true);
        });

        it('leaves a cached Accessory without context.host unassociated until a Component claims it', () => {
            const { registry, registerPlatformAccessories } = createRegistry();
            const accessory = new FakePlatformAccessory('office-light', 'uuid-office-light');
            const sensorService = new SensorService();
            accessory.addService(sensorService);
            registry.restore(accessory as unknown as PlatformAccessory);
            const session = createFakeDeviceSession();
            registry.bind(resolvedDevice(), session.session);

            session.emitAlive(true);
            expect(sensorService.testCharacteristic(StatusActiveCharacteristic)).toBe(false);

            session.emitComponents([light()]);

            expect(accessory.context.host).toBe('esp-one.local');
            expect(sensorService.getCharacteristic(StatusActiveCharacteristic).value).toBe(true);
            expect(registerPlatformAccessories).not.toHaveBeenCalled();
        });
    });

    describe('restore', () => {
        it('unregisters a blacklisted cached Accessory and does not adopt it', () => {
            const { registry, unregisterPlatformAccessories, debug } = createRegistry({ blacklist: ['forbidden'] });
            const accessory = new FakePlatformAccessory('forbidden', 'uuid-forbidden');

            registry.restore(accessory as unknown as PlatformAccessory);

            expect(unregisteredAccessories(unregisterPlatformAccessories)).toEqual([accessory]);
            expect(debug).toHaveBeenCalledWith(
                expect.stringContaining('unregistered forbidden because it was blacklisted'),
                expect.anything(),
            );
        });

        it('adopts a cached Accessory once even when Homebridge hands it over twice', () => {
            const helper = vi.fn(okHelper);
            const { registry, registerPlatformAccessories } = createRegistry({
                helpers: helperTable([['light', helper]]),
            });
            const accessory = new FakePlatformAccessory('office-light', 'uuid-office-light');
            accessory.context.host = 'esp-one.local';
            registry.restore(accessory as unknown as PlatformAccessory);
            registry.restore(accessory as unknown as PlatformAccessory);
            const session = createFakeDeviceSession();
            registry.bind(resolvedDevice(), session.session);

            session.emitComponents([light()]);

            expect(helper).toHaveBeenCalledTimes(1);
            expect(registerPlatformAccessories).not.toHaveBeenCalled();
        });

        it('ignores a distinct object handed over for an already-adopted UUID', () => {
            const { registry } = createRegistry();
            const adopted = new FakePlatformAccessory('office-light', 'uuid-office-light');
            adopted.context.host = 'esp-one.local';
            const adoptedService = new SensorService();
            adopted.addService(adoptedService);
            registry.restore(adopted as unknown as PlatformAccessory);

            const impostor = new FakePlatformAccessory('office-light', 'uuid-office-light');
            impostor.context.host = 'esp-one.local';
            const impostorService = new SensorService();
            impostor.addService(impostorService);
            registry.restore(impostor as unknown as PlatformAccessory);

            const session = createFakeDeviceSession();
            registry.bind(resolvedDevice(), session.session);
            session.emitAlive(true);

            expect(adoptedService.getCharacteristic(StatusActiveCharacteristic).value).toBe(true);
            // The impostor never joined the device lists, so it never received a status write.
            expect(impostorService.testCharacteristic(StatusActiveCharacteristic)).toBe(false);
        });
    });

    describe('stop', () => {
        it('runs every binding teardown, tears down the alive watch, and leaves Accessories registered', () => {
            const teardown = vi.fn();
            const helper: ComponentHelper = () => teardown;
            const { registry, registerPlatformAccessories, unregisterPlatformAccessories } = createRegistry({
                helpers: helperTable([['light', helper]]),
            });
            const session = createFakeDeviceSession();
            registry.bind(resolvedDevice(), session.session);
            session.emitComponents([light()]);
            expect(session.alive$.observed).toBe(true);

            registry.stop();
            registry.stop();

            expect(teardown).toHaveBeenCalledTimes(1);
            expect(session.alive$.observed).toBe(false);
            expect(registerPlatformAccessories).toHaveBeenCalledTimes(1);
            expect(unregisterPlatformAccessories).not.toHaveBeenCalled();
        });

        it('ignores bind and restore after stop', () => {
            const { registry, registerPlatformAccessories, unregisterPlatformAccessories } = createRegistry();
            registry.stop();
            const session = createFakeDeviceSession();

            registry.bind(resolvedDevice({ host: 'esp-late.local' }), session.session);
            registry.restore(new FakePlatformAccessory('late', 'uuid-late') as unknown as PlatformAccessory);
            session.emitComponents([light('late-light')]);

            expect(registerPlatformAccessories).not.toHaveBeenCalled();
            expect(unregisterPlatformAccessories).not.toHaveBeenCalled();
        });
    });

    describe('logging', () => {
        it('routes bookkeeping to the debug log unless debug is enabled', () => {
            const quiet = createRegistry();
            const quietSession = createFakeDeviceSession();
            quiet.registry.bind(resolvedDevice(), quietSession.session);
            quietSession.emitComponents([light()]);
            expect(quiet.debug).toHaveBeenCalledWith('office-light must be a new accessory', []);
            expect(quiet.base).toHaveBeenCalledWith('office-light discovered and setup.');

            const loud = createRegistry({ debug: true });
            const loudSession = createFakeDeviceSession();
            loud.registry.bind(resolvedDevice(), loudSession.session);
            loudSession.emitComponents([light()]);
            expect(loud.base).toHaveBeenCalledWith('office-light must be a new accessory', []);
        });
    });
});
