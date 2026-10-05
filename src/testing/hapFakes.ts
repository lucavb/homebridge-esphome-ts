import type { CharacteristicValue, PlatformAccessory } from 'homebridge';

/**
 * Shared hap-nodejs test doubles for specs. Faithful at the boundaries the plugin
 * exercises (see CODING_STANDARDS.md, fiction rule):
 *
 * - `testCharacteristic(constructor)` is a pure class-aware existence check — no side effects.
 * - `getCharacteristic(constructor)` models real hap-nodejs auto-add semantics
 *   (@homebridge/hap-nodejs Service.js getCharacteristic): it ALWAYS returns a
 *   characteristic and never `undefined`. A missing characteristic is auto-added —
 *   silently when it is listed among the service's optional characteristics (tracked in
 *   `autoAddedCharacteristics`, so specs can assert zero auto-adds), or with a warning
 *   when it is not — real hap logs there; this fake is silent but tracks such unlisted
 *   additions separately in `autoAddedUnlistedCharacteristics`.
 * - `addCharacteristic` is the silent instance-form add.
 * - Service classes pre-create their mandatory characteristics on construction, like real
 *   hap-nodejs services do.
 *
 * These fakes exist because the real hap classes cannot run in-process; reach for real
 * classes from installed dependencies everywhere else.
 */

export interface FakeHapCharacteristic {
    UUID: string;
    /**
     * DELIBERATE harness sentinel, not real hap default initialization: a characteristic
     * nobody wrote reads as `undefined`. Real hap's `getValue()` instead serves
     * `getDefaultValue()` (On → `false`, numerics → minValue/0) for never-written
     * characteristics.
     */
    value: CharacteristicValue | undefined;
    setValue: (value: CharacteristicValue) => void;
    updateValue: (value: CharacteristicValue) => void;
}

export interface FakeHapCharacteristicConstructor {
    new (initialValue?: CharacteristicValue): FakeHapCharacteristic;
    readonly UUID: string;
}

export type FakeHapServiceConstructor = {
    new (name?: string, subtype?: string): FakeHapService;
    readonly UUID: string;
};

export interface FakeHapService {
    UUID: string;
    name: string;
    subtype: string;
    characteristics: Map<string, FakeHapCharacteristic>;
    optionalCharacteristics: FakeHapCharacteristicConstructor[];
    autoAddedCharacteristics: FakeHapCharacteristic[];
    autoAddedUnlistedCharacteristics: FakeHapCharacteristic[];
    testCharacteristic: (constructor: FakeHapCharacteristicConstructor) => boolean;
    getCharacteristic: (constructor: FakeHapCharacteristicConstructor) => FakeHapCharacteristic;
    addCharacteristic: (characteristic: FakeHapCharacteristic) => FakeHapCharacteristic;
}

/** Creates a fake Characteristic class (static and instance UUID, value state, setValue/updateValue). */
export const makeFakeCharacteristicClass = (uuid: string): FakeHapCharacteristicConstructor => {
    class FakeHapCharacteristic implements FakeHapCharacteristic {
        public static readonly UUID = uuid;
        public readonly UUID = uuid;
        public value: CharacteristicValue | undefined;

        public constructor(initialValue?: CharacteristicValue) {
            this.value = initialValue;
        }

        public setValue(value: CharacteristicValue): void {
            this.value = value;
        }

        public updateValue(value: CharacteristicValue): void {
            this.value = value;
        }
    }
    return FakeHapCharacteristic;
};

/**
 * Creates a fake Service construction class. Instances pre-create their mandatory
 * characteristics; like real hap-nodejs (Service.js getCharacteristic), `getCharacteristic`
 * auto-adds any missing characteristic — optional-listed adds are tracked in
 * `autoAddedCharacteristics`, unlisted adds in `autoAddedUnlistedCharacteristics`.
 */
export const makeFakeServiceClass = (
    uuid: string,
    mandatoryCharacteristics: FakeHapCharacteristicConstructor[] = [],
): FakeHapServiceConstructor => {
    class FakeHapService implements FakeHapService {
        public static readonly UUID = uuid;
        public readonly UUID = uuid;
        public readonly name: string;
        public readonly subtype: string;
        public readonly characteristics = new Map<string, FakeHapCharacteristic>();
        public optionalCharacteristics: FakeHapCharacteristicConstructor[] = [];
        public autoAddedCharacteristics: FakeHapCharacteristic[] = [];
        public autoAddedUnlistedCharacteristics: FakeHapCharacteristic[] = [];

        public constructor(name = '', subtype = '') {
            this.name = name;
            this.subtype = subtype;
            for (const constructor of mandatoryCharacteristics) {
                this.characteristics.set(constructor.UUID, new constructor());
            }
        }

        public testCharacteristic(constructor: FakeHapCharacteristicConstructor): boolean {
            return this.characteristics.has(constructor.UUID);
        }

        public getCharacteristic(constructor: FakeHapCharacteristicConstructor): FakeHapCharacteristic {
            const existing = this.characteristics.get(constructor.UUID);
            if (existing) {
                return existing;
            }
            // Real hap-nodejs (Service.js getCharacteristic) auto-adds a missing
            // characteristic on every lookup: silently for optional-listed ones, with a
            // warning otherwise — this fake stays silent in both cases.
            const autoAdded = new constructor();
            this.characteristics.set(autoAdded.UUID, autoAdded);
            if (this.optionalCharacteristics.some((option) => option.UUID === constructor.UUID)) {
                this.autoAddedCharacteristics.push(autoAdded);
            } else {
                this.autoAddedUnlistedCharacteristics.push(autoAdded);
            }
            return autoAdded;
        }

        public addCharacteristic(characteristic: FakeHapCharacteristic): FakeHapCharacteristic {
            this.characteristics.set(characteristic.UUID, characteristic);
            return characteristic;
        }
    }
    return FakeHapService;
};

/**
 * Readability narrowing helper: `getCharacteristic` never returns `undefined`
 * (faithful auto-add semantics), so this simply forwards — kept so call sites still
 * read as presence assertions.
 */
export const assertCharacteristic = (
    service: FakeHapService,
    constructor: FakeHapCharacteristicConstructor,
): FakeHapCharacteristic => service.getCharacteristic(constructor);

/** Builds a PlatformAccessory-shaped object from fake services (boundary cast, sanctioned). */
export const platformAccessoryWith = (...services: FakeHapService[]) => ({ services }) as unknown as PlatformAccessory;

/** Faithful stand-in for homebridge's api.hap.HapStatusError: stores the hapStatus code it was constructed with (real hap exposes .hapStatus). The fake apis pass a string constant, so the code is a string in the fake world. */
export class FakeHapStatusError extends Error {
    public constructor(
        public readonly hapStatus: string,
        message?: string,
    ) {
        super(message ?? `fake HapStatusError (${String(hapStatus)})`);
    }
}

/** Minimal PlatformAccessory double shared by specs: services array + addService, with the backing context exposed for assertions (consolidates five identical local factories). */
export const createFakeAccessory = (...preExistingServices: FakeHapService[]) => {
    const context = { services: [...preExistingServices] };
    const accessory = {
        services: context.services,
        addService(service: FakeHapService): FakeHapService {
            context.services.push(service);
            return service;
        },
    } as unknown as PlatformAccessory;
    return { accessory, context };
};
