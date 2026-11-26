import { describe, expect, it, vi } from 'vitest';
import type { API, CharacteristicValue, PlatformAccessory } from 'homebridge';
import { BehaviorSubject, filter } from 'rxjs';
import { CoverComponent, CoverOperation, LegacyCoverState } from 'esphome-ts';
import type { BaseComponent, CoverEntity, CoverStateEvent } from 'esphome-ts';
import { ok } from 'node:assert/strict';

import { coverHelper } from './cover.js';
import {
    assertCharacteristic,
    createFakeAccessory,
    FakeHapStatusError,
    makeFakeCharacteristicClass,
    makeFakeServiceClass,
    type FakeHapCharacteristic,
    type FakeHapService,
} from '../testing/hapFakes.js';

const CURRENT_POSITION_CHARACTERISTIC = makeFakeCharacteristicClass('current-position-uuid');
const TARGET_POSITION_CHARACTERISTIC = makeFakeCharacteristicClass('target-position-uuid');
const HOLD_POSITION_CHARACTERISTIC = makeFakeCharacteristicClass('hold-position-uuid');
const CURRENT_TILT_CHARACTERISTIC = makeFakeCharacteristicClass('current-horizontal-tilt-angle-uuid');
const TARGET_TILT_CHARACTERISTIC = makeFakeCharacteristicClass('target-horizontal-tilt-angle-uuid');

/**
 * Stand-in for the real hap Characteristic.PositionState class: the helper only reads its static
 * DECREASING/INCREASING/STOPPED constants (real hap values 0/1/2); it is never constructed here
 * because PositionState has no GET/SET wiring.
 */
const PositionStateCharacteristic = Object.assign(makeFakeCharacteristicClass('position-state-uuid'), {
    DECREASING: 0,
    INCREASING: 1,
    STOPPED: 2,
});

const FakeWindowCoveringService = makeFakeServiceClass('window-covering-uuid', [
    CURRENT_POSITION_CHARACTERISTIC,
    TARGET_POSITION_CHARACTERISTIC,
    PositionStateCharacteristic,
    HOLD_POSITION_CHARACTERISTIC,
]);

const createFakeApi = () =>
    ({
        hap: {
            Service: { WindowCovering: FakeWindowCoveringService },
            Characteristic: {
                CurrentPosition: CURRENT_POSITION_CHARACTERISTIC,
                TargetPosition: TARGET_POSITION_CHARACTERISTIC,
                PositionState: PositionStateCharacteristic,
                HoldPosition: HOLD_POSITION_CHARACTERISTIC,
                CurrentHorizontalTiltAngle: CURRENT_TILT_CHARACTERISTIC,
                TargetHorizontalTiltAngle: TARGET_TILT_CHARACTERISTIC,
            },
            HapStatusError: FakeHapStatusError,
            HAPStatus: { SERVICE_COMMUNICATION_FAILURE: 'SERVICE_COMMUNICATION_FAILURE' },
        },
    }) as unknown as API;

interface FakeCoverOptions {
    supportsPosition?: boolean;
    supportsTilt?: boolean;
    supportsStop?: boolean;
    normalizedPosition?: boolean;
}

/** What the device currently reports; only echo()/manual mutation touches it, commands never do. */
interface ReportedCoverState {
    position: number | undefined;
    isClosed: boolean | undefined;
    tilt: number | undefined;
    operation: CoverOperation | undefined;
}

const createFakeCoverComponent = (options: FakeCoverOptions = {}) => {
    /**
     * Faithful to esphome-ts v5 state$: built from a BehaviorSubject(undefined) filtered on
     * undefined, so late subscribers (each binding row) get the current state replayed at
     * subscribe time (esphome-ts dist/index.js:6504-6530). v5 shallow-compare dedup drops
     * identical re-sent states upstream of the contract this fake models.
     */
    const state = new BehaviorSubject<unknown>(undefined);
    const state$ = state.pipe(filter((value) => value !== undefined));

    const open = vi.fn();
    const close = vi.fn();
    const stop = vi.fn();
    const setPosition = vi.fn();
    const setTilt = vi.fn();

    const reported: ReportedCoverState = {
        position: undefined,
        isClosed: undefined,
        tilt: undefined,
        operation: undefined,
    };

    /**
     * Boundary fake: sits on the real CoverComponent.prototype (the helper narrows with
     * instanceof) and shadows the live surface the helper reads with spec-owned state.
     * All methods are pure command recorders in the light.spec style — the reported state
     * changes only when the device echoes it back (see echo() below or direct mutation).
     */
    const component = Object.create(CoverComponent.prototype) as CoverComponent;
    Object.defineProperty(component, 'name', { enumerable: true, get: () => 'TestCover' });
    Object.defineProperty(component, 'state$', { enumerable: true, get: () => state$ });
    Object.defineProperty(component, 'supportsPosition', {
        enumerable: true,
        get: () => options.supportsPosition ?? false,
    });
    Object.defineProperty(component, 'supportsTilt', { enumerable: true, get: () => options.supportsTilt ?? false });
    Object.defineProperty(component, 'position', {
        enumerable: true,
        get: () => (options.normalizedPosition === false ? undefined : reported.position),
    });
    Object.defineProperty(component, 'tilt', { enumerable: true, get: () => reported.tilt });
    Object.defineProperty(component, 'operation', { enumerable: true, get: () => reported.operation });
    Object.defineProperty(component, 'isClosed', {
        enumerable: true,
        get: () => reported.isClosed,
    });
    Object.defineProperty(component, 'supportsStop', { enumerable: true, get: () => options.supportsStop });
    Object.defineProperty(component, 'open', { enumerable: true, value: open });
    Object.defineProperty(component, 'close', { enumerable: true, value: close });
    Object.defineProperty(component, 'stop', { enumerable: true, value: stop });
    Object.defineProperty(component, 'setPosition', { enumerable: true, value: setPosition });
    Object.defineProperty(component, 'setTilt', { enumerable: true, value: setTilt });

    /**
     * Device echo: updates the reported fields AND pushes the same payload on state$, like the
     * real device confirming a command or reporting a change on its own (CoverStateEvent shape).
     */
    const echo = (changes: Omit<Partial<CoverStateEvent>, 'key'>, eventPosition?: number): void => {
        if (changes.position !== undefined) {
            reported.position = changes.position;
            reported.isClosed = changes.position === 0;
        }
        if (changes.tilt !== undefined) {
            reported.tilt = changes.tilt;
        }
        if (changes.currentOperation !== undefined) {
            reported.operation = changes.currentOperation;
        }
        state.next({ ...changes, ...(eventPosition === undefined ? {} : { position: eventPosition }) });
    };

    return { component, reported, state, echo, open, close, stop, setPosition, setTilt };
};

/** Lets a would-be (wrong) setValue re-entry settle before asserting side effects. */
const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const coveringServiceOf = (accessory: PlatformAccessory): FakeHapService =>
    accessory.services[0] as unknown as FakeHapService;

const coverCharacteristicsOf = (accessory: PlatformAccessory) => {
    const service = coveringServiceOf(accessory);
    return {
        service,
        currentPosition: assertCharacteristic(service, CURRENT_POSITION_CHARACTERISTIC),
        targetPosition: assertCharacteristic(service, TARGET_POSITION_CHARACTERISTIC),
        positionState: assertCharacteristic(service, PositionStateCharacteristic),
        holdPosition: assertCharacteristic(service, HOLD_POSITION_CHARACTERISTIC),
        currentTilt: assertCharacteristic(service, CURRENT_TILT_CHARACTERISTIC),
        targetTilt: assertCharacteristic(service, TARGET_TILT_CHARACTERISTIC),
    };
};

/** Invokes the stored onSet handler directly (setValue/updateValue pushes never re-run it). */
const invokeSet = async (characteristic: FakeHapCharacteristic, value: CharacteristicValue): Promise<unknown> => {
    const handler = characteristic.setHandler;
    ok(handler, 'expected an onSet handler to be registered');
    return await handler(value);
};

describe('coverHelper', () => {
    it('binds real CoverComponent public state getters to WindowCovering readback and pushes', () => {
        const entity: CoverEntity = {
            key: 15,
            name: 'RealCover',
            uniqueId: 'real-cover-id',
            objectId: 'real_cover',
            assumedState: false,
            supportsPosition: false,
            supportsTilt: false,
            supportsStop: true,
            deviceClass: '',
        };
        // Model the decoded modern cover event while keeping legacyState at the decoder's
        // default OPEN value. position, not that legacy default, distinguishes closed/open.
        const states = new BehaviorSubject<CoverStateEvent>({
            key: 15,
            position: 0,
            legacyState: LegacyCoverState.LEGACY_COVER_STATE_OPEN,
            currentOperation: CoverOperation.COVER_OPERATION_IDLE,
        });
        const commandInterface = { sendEspMessage: vi.fn() };
        const component = new CoverComponent(entity, states, commandInterface);
        const { accessory, context } = createFakeAccessory();

        const teardown = coverHelper(component, accessory, createFakeApi());
        const { currentPosition, targetPosition, holdPosition } = coverCharacteristicsOf(accessory);

        expect(context.services).toHaveLength(1);
        // Released 5.1 hides position when supportsPosition is false; the newer API exposes
        // normalized position. Both versions must bind the same public state correctly.
        expect([undefined, 0]).toContain(component.position);
        expect(currentPosition.value).toBe(0);
        expect(targetPosition.value).toBe(0);

        // BaseComponent updates its public state before notifying binding subscribers.
        states.next({
            key: 15,
            position: 1,
            legacyState: LegacyCoverState.LEGACY_COVER_STATE_OPEN,
            currentOperation: CoverOperation.COVER_OPERATION_IDLE,
        });
        expect(component.isClosed).toBe(false);
        expect(currentPosition.value).toBe(100);
        expect(targetPosition.value).toBe(100);

        const supportsStop = component.supportsStop;
        if (supportsStop) {
            expect(holdPosition.getHandler).toBeTypeOf('function');
            expect(holdPosition.setHandler).toBeTypeOf('function');
        } else {
            expect(holdPosition.getHandler).toBeUndefined();
            expect(holdPosition.setHandler).toBeUndefined();
        }
        teardown?.();
    });

    it('uses a real API 1.0 CoverComponent legacy getter and stop capability', async () => {
        const entity: CoverEntity = {
            key: 16,
            name: 'LegacyCover',
            uniqueId: 'legacy-cover-id',
            objectId: 'legacy_cover',
            assumedState: false,
            supportsPosition: true,
            supportsTilt: false,
            supportsStop: false,
            deviceClass: '',
        };
        const states = new BehaviorSubject<CoverStateEvent>({
            key: 16,
            position: 0,
            legacyState: LegacyCoverState.LEGACY_COVER_STATE_CLOSED,
            currentOperation: CoverOperation.COVER_OPERATION_IDLE,
        });
        const commandInterface = { sendEspMessage: vi.fn() };
        // API 1.0 has no position feedback; isClosed uses legacyState, and stop is supported
        // regardless of the API 1.8+ per-device supportsStop flag.
        const component = new CoverComponent(entity, states, commandInterface, { major: 1, minor: 0 });
        const { accessory } = createFakeAccessory();

        const teardown = coverHelper(component, accessory, createFakeApi());
        const { currentPosition, holdPosition } = coverCharacteristicsOf(accessory);
        expect(component.position).toBeUndefined();
        expect(component.isClosed).toBe(true);
        expect(component.supportsStop).toBe(true);
        expect(currentPosition.value).toBe(0);
        ok(holdPosition.setHandler);

        await invokeSet(holdPosition, false);
        expect(commandInterface.sendEspMessage).not.toHaveBeenCalled();
        await invokeSet(holdPosition, true);
        expect(commandInterface.sendEspMessage).toHaveBeenCalledTimes(1);

        states.next({
            key: 16,
            position: 0, // Modern scalar's default does not represent legacy OPEN.
            legacyState: LegacyCoverState.LEGACY_COVER_STATE_OPEN,
            currentOperation: CoverOperation.COVER_OPERATION_IDLE,
        });
        expect(component.isClosed).toBe(false);
        expect(currentPosition.value).toBe(100);
        teardown?.();
    });

    it('returns undefined for a component failing the instanceof guard without touching the accessory', () => {
        // A plain object is not on CoverComponent.prototype, so `component instanceof
        // CoverComponent` (cover.ts) is false for it.
        const impostor = { name: 'impostor' } as unknown as BaseComponent;
        const { accessory, context } = createFakeAccessory();

        expect(coverHelper(impostor, accessory, createFakeApi())).toBeUndefined();
        expect(context.services).toHaveLength(0);
    });

    it('returns a teardown function', () => {
        const cover = createFakeCoverComponent();
        const { accessory } = createFakeAccessory();

        const teardown = coverHelper(cover.component, accessory, createFakeApi());

        expect(teardown).toBeTypeOf('function');
        expect(() => teardown?.()).not.toThrow();
    });

    it('adds one WindowCovering service named after the component', () => {
        const cover = createFakeCoverComponent();
        const { accessory, context } = createFakeAccessory();

        coverHelper(cover.component, accessory, createFakeApi());

        expect(context.services).toHaveLength(1);
        expect(context.services[0]).toHaveProperty('UUID', 'window-covering-uuid');
        expect(context.services[0]).toHaveProperty('name', 'TestCover');
    });

    it('reuses an existing WindowCovering service instead of adding one', () => {
        const cover = createFakeCoverComponent();
        const existingService = new FakeWindowCoveringService('TestCover');
        const { accessory, context } = createFakeAccessory(existingService);
        const spyService = vi.spyOn(accessory, 'addService');

        coverHelper(cover.component, accessory, createFakeApi());

        expect(spyService).not.toHaveBeenCalled();
        expect(context.services).toHaveLength(1);
    });

    describe('position readback', () => {
        it('the GET handler converts esphome position 0..1 into HomeKit 0..100 percent with rounding', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: true });
            cover.reported.position = 0.876;
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { currentPosition, targetPosition } = coverCharacteristicsOf(accessory);
            ok(currentPosition.getHandler, 'expected a CurrentPosition onGet handler');
            ok(targetPosition.getHandler, 'expected a TargetPosition onGet handler');

            // 0.876 * 100 = 87.6 → 88. TargetPosition reads the same value at rest.
            expect(await currentPosition.getHandler()).toBe(88);
            expect(await targetPosition.getHandler()).toBe(88);

            cover.reported.position = 0;
            expect(await currentPosition.getHandler()).toBe(0);

            cover.reported.position = 1;
            expect(await currentPosition.getHandler()).toBe(100);
        });

        it('a GET reports service communication failure while no state has arrived yet', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { currentPosition } = coverCharacteristicsOf(accessory);
            const getHandler = currentPosition.getHandler;
            ok(getHandler, 'expected a CurrentPosition onGet handler');

            await expect(getHandler()).rejects.toThrow(FakeHapStatusError);
            await expect(getHandler()).rejects.toMatchObject({ hapStatus: 'SERVICE_COMMUNICATION_FAILURE' });
        });

        it('a cover without position commands reads normalized modern position feedback', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: false, normalizedPosition: true });
            cover.reported.position = 0;
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { currentPosition, targetPosition } = coverCharacteristicsOf(accessory);
            ok(currentPosition.getHandler);
            ok(targetPosition.getHandler);

            expect(await currentPosition.getHandler()).toBe(0);
            expect(await targetPosition.getHandler()).toBe(0);

            cover.reported.position = 1;
            expect(await currentPosition.getHandler()).toBe(100);
        });

        it('a GET reports service communication failure while no cover state is known', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: false });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { currentPosition } = coverCharacteristicsOf(accessory);
            const getHandler = currentPosition.getHandler;
            ok(getHandler, 'expected a CurrentPosition onGet handler');

            await expect(getHandler()).rejects.toThrow(FakeHapStatusError);
            await expect(getHandler()).rejects.toMatchObject({ hapStatus: 'SERVICE_COMMUNICATION_FAILURE' });
        });

        it('uses normalized modern position or the binary isClosed fallback for legacy protocol', async () => {
            // Position is authoritative on modern firmware even if position commands aren't supported.
            const positionCover = createFakeCoverComponent({ supportsPosition: true });
            positionCover.reported.position = 0.3;
            const positionAccessory = createFakeAccessory();
            coverHelper(positionCover.component, positionAccessory.accessory, createFakeApi());
            const positionCharacteristics = coverCharacteristicsOf(positionAccessory.accessory);
            const positionHandler = positionCharacteristics.currentPosition.getHandler;
            ok(positionHandler);
            // 0.3 * 100 = 30, not the legacy CLOSED → 0.
            expect(await positionHandler()).toBe(30);

            // Legacy protocol reports do not expose normalized position; use the version-correct
            // public isClosed fallback instead.
            const legacyCover = createFakeCoverComponent({ supportsPosition: false, normalizedPosition: false });
            legacyCover.reported.position = 0.3;
            legacyCover.reported.isClosed = false;
            const legacyAccessory = createFakeAccessory();
            coverHelper(legacyCover.component, legacyAccessory.accessory, createFakeApi());
            const legacyCharacteristics = coverCharacteristicsOf(legacyAccessory.accessory);
            const legacyHandler = legacyCharacteristics.currentPosition.getHandler;
            ok(legacyHandler, 'expected a CurrentPosition onGet handler');
            expect(await legacyHandler()).toBe(100);
        });
    });

    describe('apply paths', () => {
        it('a TargetPosition apply commands setPosition with the 0..1 fraction', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { targetPosition } = coverCharacteristicsOf(accessory);

            await invokeSet(targetPosition, 42);
            expect(cover.setPosition).toHaveBeenCalledTimes(1);
            expect(cover.setPosition).toHaveBeenCalledWith(0.42);
            expect(cover.open).not.toHaveBeenCalled();
            expect(cover.close).not.toHaveBeenCalled();
        });

        it('a stateless cover applies 50 and above as open()', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: false });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { targetPosition } = coverCharacteristicsOf(accessory);

            await invokeSet(targetPosition, 50);
            expect(cover.open).toHaveBeenCalledTimes(1);
            expect(cover.close).not.toHaveBeenCalled();
            expect(cover.setPosition).not.toHaveBeenCalled();
        });

        it('a stateless cover applies below 50 as close(), including 0 and 49', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: false });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { targetPosition } = coverCharacteristicsOf(accessory);

            await invokeSet(targetPosition, 49);
            expect(cover.close).toHaveBeenCalledTimes(1);
            expect(cover.open).not.toHaveBeenCalled();

            await invokeSet(targetPosition, 0);
            expect(cover.close).toHaveBeenCalledTimes(2);
        });

        it('does not bind HoldPosition when supportsStop is false', () => {
            const cover = createFakeCoverComponent({ supportsPosition: true, supportsStop: false });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { holdPosition } = coverCharacteristicsOf(accessory);
            expect(holdPosition.getHandler).toBeUndefined();
            expect(holdPosition.setHandler).toBeUndefined();
            expect(cover.stop).not.toHaveBeenCalled();
        });

        it('binds HoldPosition only when supportsStop is true, and stops only for true writes', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: true, supportsStop: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { holdPosition } = coverCharacteristicsOf(accessory);
            ok(holdPosition.getHandler);
            ok(holdPosition.setHandler);
            expect(await holdPosition.getHandler()).toBe(false);

            await invokeSet(holdPosition, false);
            expect(cover.stop).not.toHaveBeenCalled();
            await invokeSet(holdPosition, true);
            expect(cover.stop).toHaveBeenCalledTimes(1);
        });

        it('throws a HapStatusError with SERVICE_COMMUNICATION_FAILURE when the device write fails', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: true });
            cover.setPosition.mockImplementation(() => {
                throw new Error('device gone');
            });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { targetPosition } = coverCharacteristicsOf(accessory);

            await expect(invokeSet(targetPosition, 42)).rejects.toThrow(FakeHapStatusError);
            await expect(invokeSet(targetPosition, 42)).rejects.toMatchObject({
                hapStatus: 'SERVICE_COMMUNICATION_FAILURE',
            });
            expect(cover.setPosition).toHaveBeenCalledWith(0.42);
        });
    });

    describe('PositionState mapping', () => {
        it('maps each CoverOperation to the api.hap PositionState enum value, STOPPED as default', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { positionState } = coverCharacteristicsOf(accessory);
            ok(positionState.getHandler, 'expected a PositionState onGet handler');

            // Undefined operation (no state yet) reads as at-rest before anything arrives.
            expect(await positionState.getHandler()).toBe(PositionStateCharacteristic.STOPPED);

            cover.reported.operation = CoverOperation.COVER_OPERATION_IS_OPENING;
            expect(await positionState.getHandler()).toBe(PositionStateCharacteristic.INCREASING);

            cover.reported.operation = CoverOperation.COVER_OPERATION_IS_CLOSING;
            expect(await positionState.getHandler()).toBe(PositionStateCharacteristic.DECREASING);

            cover.reported.operation = CoverOperation.COVER_OPERATION_IDLE;
            expect(await positionState.getHandler()).toBe(PositionStateCharacteristic.STOPPED);
        });
    });

    describe('tilt rows', () => {
        it('wires CurrentHorizontalTiltAngle and TargetHorizontalTiltAngle only when supportsTilt', () => {
            const withTilt = createFakeCoverComponent({ supportsPosition: true, supportsTilt: true });
            const withTiltAccessory = createFakeAccessory();
            coverHelper(withTilt.component, withTiltAccessory.accessory, createFakeApi());
            const tiltCharacteristics = coverCharacteristicsOf(withTiltAccessory.accessory);
            expect(tiltCharacteristics.currentTilt.getHandler).toBeTypeOf('function');
            expect(tiltCharacteristics.targetTilt.setHandler).toBeTypeOf('function');

            const withoutTilt = createFakeCoverComponent({ supportsPosition: true, supportsTilt: false });
            const withoutTiltAccessory = createFakeAccessory();
            coverHelper(withoutTilt.component, withoutTiltAccessory.accessory, createFakeApi());
            const flatCharacteristics = coverCharacteristicsOf(withoutTiltAccessory.accessory);
            expect(flatCharacteristics.currentTilt.getHandler).toBeUndefined();
            expect(flatCharacteristics.currentTilt.setHandler).toBeUndefined();
            expect(flatCharacteristics.targetTilt.getHandler).toBeUndefined();
            expect(flatCharacteristics.targetTilt.setHandler).toBeUndefined();
        });

        it('the GET handler converts esphome tilt 0..1 into HomeKit angles -90..90 with rounding', async () => {
            const cover = createFakeCoverComponent({ supportsTilt: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { currentTilt, targetTilt } = coverCharacteristicsOf(accessory);
            ok(currentTilt.getHandler, 'expected a CurrentHorizontalTiltAngle onGet handler');
            ok(targetTilt.getHandler, 'expected a TargetHorizontalTiltAngle onGet handler');

            cover.reported.tilt = 1;
            expect(await currentTilt.getHandler()).toBe(90);
            cover.reported.tilt = 0;
            expect(await currentTilt.getHandler()).toBe(-90);
            cover.reported.tilt = 0.5;
            expect(await currentTilt.getHandler()).toBe(0);
            // 0.25 * 180 - 90 = -45
            cover.reported.tilt = 0.25;
            expect(await targetTilt.getHandler()).toBe(-45);
        });

        it('a TargetHorizontalTiltAngle apply commands setTilt with the 0..1 fraction', async () => {
            const cover = createFakeCoverComponent({ supportsTilt: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { targetTilt } = coverCharacteristicsOf(accessory);

            await invokeSet(targetTilt, 45);
            expect(cover.setTilt).toHaveBeenCalledWith(0.75);

            await invokeSet(targetTilt, -90);
            expect(cover.setTilt).toHaveBeenCalledWith(0);

            await invokeSet(targetTilt, 90);
            expect(cover.setTilt).toHaveBeenCalledWith(1);
        });
    });

    describe('state$ pushes', () => {
        it('projects a position echo onto CurrentPosition and an operation echo onto PositionState', () => {
            const cover = createFakeCoverComponent({ supportsPosition: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { currentPosition, positionState } = coverCharacteristicsOf(accessory);

            cover.echo({ position: 0.4, currentOperation: CoverOperation.COVER_OPERATION_IS_OPENING });
            expect(currentPosition.value).toBe(40);
            expect(positionState.value).toBe(PositionStateCharacteristic.INCREASING);

            cover.echo({ position: 0.9, currentOperation: CoverOperation.COVER_OPERATION_IDLE });
            expect(currentPosition.value).toBe(90);
            expect(positionState.value).toBe(PositionStateCharacteristic.STOPPED);
        });

        it('uses normalized component position instead of defaulted event position when supportsPosition is false', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: false, normalizedPosition: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { currentPosition } = coverCharacteristicsOf(accessory);

            cover.echo({ position: 0 }, 0);
            expect(currentPosition.value).toBe(0);

            // Model a legacy-defaulted event value of zero while the component exposes the
            // normalized modern position from the device (BaseComponent updates before observers).
            cover.echo({ position: 1 }, 0);
            expect(currentPosition.value).toBe(100);

            cover.echo({ position: 0.3 }, 0);
            expect(currentPosition.value).toBe(30);
            ok(currentPosition.getHandler);
            expect(await currentPosition.getHandler()).toBe(30);
            expect(cover.setPosition).not.toHaveBeenCalled();
            expect(cover.open).not.toHaveBeenCalled();
            expect(cover.close).not.toHaveBeenCalled();
        });

        it('uses public isClosed for legacy covers whose decoded event position defaults to zero', () => {
            const cover = createFakeCoverComponent({ supportsPosition: false });
            cover.reported.isClosed = true;
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { currentPosition } = coverCharacteristicsOf(accessory);

            cover.echo({}, 0);
            expect(currentPosition.value).toBe(0);

            // Legacy open is represented by isClosed=false even though the decoded event
            // still contains its scalar default position=0. The helper must ignore that raw field.
            cover.reported.isClosed = false;
            cover.echo({}, 0);
            expect(currentPosition.value).toBe(100);
        });

        it('a remote echo moves the TargetPosition readback alongside CurrentPosition', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { targetPosition } = coverCharacteristicsOf(accessory);

            cover.echo({ position: 0.75 });
            ok(targetPosition.getHandler);
            expect(await targetPosition.getHandler()).toBe(75);
            expect(targetPosition.value).toBe(75);
            expect(cover.setPosition).not.toHaveBeenCalled();
        });

        it('keeps a commanded target while moving, then reconciles target to the reported completion position', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { targetPosition } = coverCharacteristicsOf(accessory);
            ok(targetPosition.getHandler);

            await invokeSet(targetPosition, 80);
            expect(await targetPosition.getHandler()).toBe(80);
            cover.echo({ position: 0.2 });
            expect(targetPosition.value).toBe(80);
            cover.echo({ position: 0.3, currentOperation: CoverOperation.COVER_OPERATION_IS_OPENING });
            expect(targetPosition.value).toBe(80);
            expect(await targetPosition.getHandler()).toBe(80);

            cover.echo({ position: 0.7, currentOperation: CoverOperation.COVER_OPERATION_IDLE });
            expect(targetPosition.value).toBe(70);
            expect(await targetPosition.getHandler()).toBe(70);

            // A spurious idle report before the requested destination is reached must still
            // reconcile the target to device truth rather than leave a stale local command.
            await invokeSet(targetPosition, 20);
            cover.echo({ position: 0.65, currentOperation: CoverOperation.COVER_OPERATION_IDLE });
            expect(targetPosition.value).toBe(65);
            expect(await targetPosition.getHandler()).toBe(65);
            expect(cover.setPosition).toHaveBeenCalledTimes(2);
        });

        it('skips the position and tilt pushes while nothing is computable, so undefined never lands', () => {
            const cover = createFakeCoverComponent({ supportsPosition: true, supportsTilt: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { currentPosition, positionState, currentTilt } = coverCharacteristicsOf(accessory);

            // An event without position or tilt: those pushes are skipped silently.
            cover.echo({});
            expect(currentPosition.value).toBeUndefined();
            expect(currentTilt.value).toBeUndefined();
            // PositionState always computes (STOPPED before any operation).
            expect(positionState.value).toBe(PositionStateCharacteristic.STOPPED);
        });

        it('projects a tilt echo onto CurrentHorizontalTiltAngle', () => {
            const cover = createFakeCoverComponent({ supportsTilt: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { currentTilt } = coverCharacteristicsOf(accessory);

            cover.echo({ tilt: 0.25 });
            expect(currentTilt.value).toBe(-45);
        });

        it('reconciles commanded tilt to an unchanged or mismatched device report instead of retaining a stale target', async () => {
            const cover = createFakeCoverComponent({ supportsTilt: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { targetTilt } = coverCharacteristicsOf(accessory);
            ok(targetTilt.getHandler);

            await invokeSet(targetTilt, 45);
            cover.echo({ tilt: 0.25 });
            expect(targetTilt.value).toBe(-45);
            expect(await targetTilt.getHandler()).toBe(-45);

            cover.echo({ tilt: 0.75 });
            expect(targetTilt.value).toBe(45);
            expect(await targetTilt.getHandler()).toBe(45);
            expect(cover.setTilt).toHaveBeenCalledTimes(1);

            await invokeSet(targetTilt, -45);
            cover.echo({ tilt: 0.75 }); // Device did not move and rejected the new target.
            expect(targetTilt.value).toBe(45);
            expect(await targetTilt.getHandler()).toBe(45);
        });

        it('pushes land via updateValue: silent, never re-entering any apply', async () => {
            const cover = createFakeCoverComponent({ supportsPosition: true, supportsTilt: true });
            const { accessory } = createFakeAccessory();

            coverHelper(cover.component, accessory, createFakeApi());
            const { currentPosition } = coverCharacteristicsOf(accessory);

            cover.echo({ position: 0.4 });
            expect(currentPosition.value).toBe(40);
            await flush(); // let a wrong setValue re-entry (if ever introduced) settle
            expect(cover.setPosition).not.toHaveBeenCalled();
            expect(cover.open).not.toHaveBeenCalled();
            expect(cover.close).not.toHaveBeenCalled();
            expect(cover.stop).not.toHaveBeenCalled();
            expect(cover.setTilt).not.toHaveBeenCalled();
        });

        it('the teardown unsubscribes the state$ pipeline so echoes stop reaching the characteristics', () => {
            const cover = createFakeCoverComponent({ supportsPosition: true });
            const { accessory } = createFakeAccessory();

            const teardown = coverHelper(cover.component, accessory, createFakeApi());
            ok(teardown, 'expected a teardown function');
            const { currentPosition } = coverCharacteristicsOf(accessory);

            cover.echo({ position: 0.4 });
            expect(currentPosition.value).toBe(40);

            teardown();
            cover.echo({ position: 0.7 });
            expect(currentPosition.value).toBe(40);
        });
    });
});
