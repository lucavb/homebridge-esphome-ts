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
 * - `setProps` merges the provided keys onto the characteristic's props (real hap
 *   Characteristic.setProps); `addLinkedService` appends to `linkedServices` (real hap
 *   Service.addLinkedService).
 * - Service classes pre-create their mandatory characteristics on construction, like real
 *   hap-nodejs services do.
 *
 * These fakes exist because the real hap classes cannot run in-process; reach for real
 * classes from installed dependencies everywhere else.
 *
 * Known divergences beyond those above: `setValue`/`updateValue` do not model real
 * hap's `validateUserInput` (Characteristic.js:2097-2136) — no minStep quantization,
 * min/max clamping, or validValues revert — because the fake characteristics carry
 * no per-class prop defaults. Specs asserting pushed floats therefore see the raw
 * plugin-computed value where real hap would serve a quantized one (e.g. a °F
 * CurrentTemperature push of 22.2222 stores as-is here, real hap serves 22.2).
 */

/** Handler shape for `onSet` registrations; rejections are swallowed on re-entry (like real hap). */
export type FakeSetHandler = (value: CharacteristicValue) => unknown;
/** Handler shape for `onGet` registrations. */
export type FakeGetHandler = () => unknown;

export interface FakeHapCharacteristic {
    UUID: string;
    /**
     * DELIBERATE harness sentinel, not real hap default initialization: a characteristic
     * nobody wrote reads as `undefined`. Real concrete hap classes initialize `this.value`
     * to `getDefaultValue()` in their constructors (e.g. On → `false`, numerics →
     * `validValues[0]`/`minValue`), and hap's read paths re-derive that default for
     * never-written characteristics.
     */
    value: CharacteristicValue | undefined;
    /**
     * Props merged through `setProps` (real hap Characteristic.props). Starts empty —
     * the fake does not model the per-class HAP defaults; specs assert only the keys
     * a binding row explicitly set.
     */
    props: Record<string, unknown>;
    setHandler: FakeSetHandler | undefined;
    getHandler: FakeGetHandler | undefined;
    /** Models real hap: registers the handler and returns the characteristic for chaining. */
    onSet: (handler: FakeSetHandler) => FakeHapCharacteristic;
    /** Models real hap: registers the handler and returns the characteristic for chaining. */
    onGet: (handler: FakeGetHandler) => FakeHapCharacteristic;
    /** Models real hap Characteristic.setProps: merges the provided keys into `props`. */
    setProps: (props: Record<string, unknown>) => FakeHapCharacteristic;
    setValue: (value: CharacteristicValue) => void;
    updateValue: (value: CharacteristicValue) => void;
}

export interface FakeHapCharacteristicConstructor {
    new (): FakeHapCharacteristic;
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
    /** Services linked through addLinkedService, like real hap Service.linkedServices. */
    linkedServices: FakeHapService[];
    /** Models real hap Service.addLinkedService: appends when not already linked. */
    addLinkedService: (service: FakeHapService) => void;
    testCharacteristic: (constructor: FakeHapCharacteristicConstructor) => boolean;
    getCharacteristic: (constructor: FakeHapCharacteristicConstructor) => FakeHapCharacteristic;
    addCharacteristic: (characteristic: FakeHapCharacteristic) => FakeHapCharacteristic;
}

/**
 * Creates a fake Characteristic class (static and instance UUID, value state,
 * onSet/onGet handler storage, setValue/updateValue).
 *
 * DELIBERATE divergence from real hap: `value` starts as `undefined` — a no-write
 * sentinel used by this harness so a characteristic nobody wrote reads as `undefined`.
 * Real hap characteristics instead serve their default value when nobody has written
 * (Characteristic.js `getValue()` → `getDefaultValue()`: On → `false`, numerics →
 * minValue/0).
 */
export const makeFakeCharacteristicClass = (uuid: string): FakeHapCharacteristicConstructor => {
    class FakeHapCharacteristic implements FakeHapCharacteristic {
        public static readonly UUID = uuid;
        public readonly UUID = uuid;
        public value: CharacteristicValue | undefined;
        public props: Record<string, unknown> = {};
        public setHandler: FakeSetHandler | undefined;
        public getHandler: FakeGetHandler | undefined;

        public constructor() {
            this.value = undefined;
        }

        public onSet(handler: FakeSetHandler): FakeHapCharacteristic {
            this.setHandler = handler;
            return this;
        }

        public onGet(handler: FakeGetHandler): FakeHapCharacteristic {
            this.getHandler = handler;
            return this;
        }

        /**
         * Models real hap Characteristic.setProps (Characteristic.js:1368+): the provided
         * keys are assigned onto the stored props. Real hap validates some keys
         * (format/perms assertions, minValue<maxValue warnings); the fake keeps the
         * merge only, which is the boundary the plugin exercises.
         */
        public setProps(props: Record<string, unknown>): FakeHapCharacteristic {
            this.props = { ...this.props, ...props };
            return this;
        }

        /**
         * Models real hap assign-on-resolve semantics (Characteristic.js:1804-1833): with a
         * registered `onSet` handler the value is stored only once the handler chain
         * resolves; on rejection (or a synchronous throw) the failure is swallowed — real
         * hap never surfaces it without a backing callback — and the value is NOT stored.
         * Without a handler the value is stored synchronously.
         */
        public setValue(value: CharacteristicValue): void {
            const handler = this.setHandler;
            if (!handler) {
                this.value = value;
                return;
            }
            try {
                void Promise.resolve(handler(value))
                    .then(() => {
                        this.value = value;
                    })
                    .catch(() => undefined);
            } catch {
                // Rejection without a callback is intentionally swallowed, like real hap.
            }
        }

        /** Models real hap (Characteristic.js:1628-1658): updates the value without re-entering `onSet`. */
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
        public linkedServices: FakeHapService[] = [];

        public constructor(name = '', subtype = '') {
            this.name = name;
            this.subtype = subtype;
            for (const constructor of mandatoryCharacteristics) {
                this.characteristics.set(constructor.UUID, new constructor());
            }
        }

        /** Models real hap Service.addLinkedService (Service.js:444): appends when not already linked. */
        public addLinkedService(service: FakeHapService): void {
            if (!this.linkedServices.includes(service)) {
                this.linkedServices.push(service);
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
