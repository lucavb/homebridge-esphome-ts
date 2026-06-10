import type { PlatformAccessory } from 'homebridge';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';

vi.mock('../hap', () => ({
    Service: {
        Switch: class {
            static UUID = 'switch-service-uuid';
            constructor(
                public name: string,
                public subtype: string,
            ) {}
        },
    },
    Characteristic: { On: 'On' },
}));

import { switchHelper } from './switch';

describe('switchHelper', () => {
    const onCharacteristic = {
        updateValue: vi.fn(),
        on: vi.fn(),
    };
    const service = {
        UUID: 'switch-service-uuid',
        getCharacteristic: vi.fn(() => onCharacteristic),
    };
    const accessory = {
        services: [service],
        addService: vi.fn(),
    } as unknown as PlatformAccessory;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('updates HomeKit when the component state changes', () => {
        const state$ = new Subject<void>();
        const component = {
            name: 'Test Switch',
            status: false,
            state$,
            turnOn: vi.fn(),
            turnOff: vi.fn(),
        };

        const subscription = switchHelper(component as never, accessory);

        expect(subscription).not.toBe(false);
        state$.next();
        expect(onCharacteristic.updateValue).toHaveBeenCalledWith(false);

        component.status = true;
        state$.next();
        expect(onCharacteristic.updateValue).toHaveBeenCalledWith(true);

        if (subscription) {
            subscription.unsubscribe();
        }
    });
});
