import { describe, expect, it, vi } from 'vitest';
import type { Logging } from 'homebridge';

import {
    createDiscoveryConfigMerge,
    DEFAULT_RETRY_AFTER,
    readDeviceEntries,
    resolveDeviceConfig,
    resolveDeviceConfigs,
} from './deviceConfig.js';
import type { DeviceConfigDefaults, RawDeviceEntry } from './deviceConfig.js';

const createFakeLogging = () => {
    const base = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const debug = vi.fn();
    const log = Object.assign(base, { info, warn, error, debug }) as unknown as Logging;
    return { log, base, info, warn, error, debug };
};

const defaults = (globalRetryAfter?: unknown): DeviceConfigDefaults => ({ globalRetryAfter });

describe('readDeviceEntries', () => {
    it('logs and ignores a non-array devices configuration', () => {
        const { log, error } = createFakeLogging();

        expect(readDeviceEntries('oops', log)).toEqual([]);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('"devices" configuration must be an array'));
    });

    it('skips non-object entries and keeps object entries in order', () => {
        const { log, error } = createFakeLogging();
        const first = { host: 'one.local' };
        const second = { host: 'two.local' };

        expect(readDeviceEntries([null, 'nope', [], first, second], log)).toEqual([first, second]);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('devices[0]'));
        expect(error).toHaveBeenCalledWith(expect.stringContaining('devices[1]'));
        expect(error).toHaveBeenCalledWith(expect.stringContaining('devices[2]'));
    });

    it('treats an absent devices value as an empty list without a warning', () => {
        const { log, error } = createFakeLogging();

        expect(readDeviceEntries(undefined, log)).toEqual([]);
        expect(error).not.toHaveBeenCalled();
    });
});

describe('resolveDeviceConfig', () => {
    it('fills defaults for a bare host', () => {
        const { log } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local' }, defaults(), log)).toEqual({
            host: 'esp-one.local',
            password: undefined,
            port: undefined,
            encryptionKey: undefined,
            retryAfter: DEFAULT_RETRY_AFTER,
            invertFanDirection: false,
        });
    });

    it.each([undefined, '', '   ', 42, null])('rejects a missing or non-string host %s', (host) => {
        const { log, error } = createFakeLogging();

        expect(resolveDeviceConfig({ host }, defaults(), log)).toBeUndefined();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('"host"'));
    });

    it('rejects a non-string password', () => {
        const { log, error } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local', password: 42 }, defaults(), log)).toBeUndefined();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('"password" configured for esp-one.local'));
    });

    it('treats a null password as unset', () => {
        const { log, warn } = createFakeLogging();

        const resolved = resolveDeviceConfig(
            { host: 'esp-one.local', password: null, encryptionKey: '  key  ' },
            defaults(),
            log,
        );

        expect(resolved?.password).toBeUndefined();
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Both "password"'));
    });

    it('coerces a numeric-string port', () => {
        const { log } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local', port: '6053' }, defaults(), log)?.port).toBe(6053);
    });

    it.each([70_000, 0, -1, true, 'abc', 6053.5])('rejects an unusable port %s', (port) => {
        const { log, error } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local', port }, defaults(), log)).toBeUndefined();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('"port"'));
    });

    it.each([undefined, null])('treats a %s port as unset', (port) => {
        const { log } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local', port }, defaults(), log)?.port).toBeUndefined();
    });

    it('rejects a non-string encryptionKey', () => {
        const { log, error } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local', encryptionKey: 42 }, defaults(), log)).toBeUndefined();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('"encryptionKey" configured for esp-one.local'));
    });

    it('trims a valid encryptionKey without a blank-key warning', () => {
        const { log, warn } = createFakeLogging();

        const resolved = resolveDeviceConfig({ host: 'esp-one.local', encryptionKey: '  abc  ' }, defaults(), log);

        expect(resolved?.encryptionKey).toBe('abc');
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('is blank'));
    });

    it.each([undefined, null, ''])('treats a %s encryptionKey as unset without a warning', (encryptionKey) => {
        const { log, warn } = createFakeLogging();

        expect(
            resolveDeviceConfig({ host: 'esp-one.local', encryptionKey }, defaults(), log)?.encryptionKey,
        ).toBeUndefined();
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('is blank'));
    });

    it('warns and treats a whitespace-only encryptionKey as unset', () => {
        const { log, warn } = createFakeLogging();

        expect(
            resolveDeviceConfig({ host: 'esp-one.local', encryptionKey: '   ' }, defaults(), log)?.encryptionKey,
        ).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('"encryptionKey" configured for esp-one.local is blank'),
        );
    });

    it('warns when both password and encryptionKey are configured', () => {
        const { log, warn } = createFakeLogging();

        const resolved = resolveDeviceConfig(
            { host: 'esp-one.local', password: 'secret', encryptionKey: 'key' },
            defaults(),
            log,
        );

        expect(resolved?.encryptionKey).toBe('key');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Both "password" and "encryptionKey"'));
    });

    it.each([true, false])('keeps a boolean invertFanDirection %s', (invertFanDirection) => {
        const { log, warn } = createFakeLogging();

        const resolved = resolveDeviceConfig({ host: 'esp-one.local', invertFanDirection }, defaults(), log);

        expect(resolved?.invertFanDirection).toBe(invertFanDirection);
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('"invertFanDirection"'));
    });

    it('warns and ignores a non-boolean invertFanDirection', () => {
        const { log, warn } = createFakeLogging();

        const resolved = resolveDeviceConfig({ host: 'esp-one.local', invertFanDirection: 'true' }, defaults(), log);

        expect(resolved?.invertFanDirection).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"invertFanDirection"'));
    });

    it('uses the default retry delay when neither level sets one', () => {
        const { log, warn } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local' }, defaults(), log)?.retryAfter).toBe(DEFAULT_RETRY_AFTER);
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('"retryAfter"'));
    });

    it('uses the global retryAfter as the device fallback', () => {
        const { log } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local' }, defaults(5_000), log)?.retryAfter).toBe(5_000);
    });

    it('prefers a per-device retryAfter over the global value', () => {
        const { log } = createFakeLogging();

        expect(
            resolveDeviceConfig({ host: 'esp-one.local', retryAfter: 2_000 }, defaults(5_000), log)?.retryAfter,
        ).toBe(2_000);
    });

    it('clamps a sub-second retryAfter to the one-second floor and warns', () => {
        const { log, warn } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local', retryAfter: 0.5 }, defaults(), log)?.retryAfter).toBe(
            1_000,
        );
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('using 1000 ms'));
    });

    it('accepts a fractional retryAfter that rounds into range without warning', () => {
        const { log, warn } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local', retryAfter: 1_000.4 }, defaults(), log)?.retryAfter).toBe(
            1_000,
        );
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('"retryAfter"'));
    });

    it('clamps an oversized retryAfter instead of letting Node fire it at 1 ms', () => {
        const { log, warn } = createFakeLogging();

        expect(
            resolveDeviceConfig({ host: 'esp-one.local', retryAfter: 3_000_000_000 }, defaults(), log)?.retryAfter,
        ).toBe(2_147_483_647);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('using 2147483647 ms'));
    });

    it.each(['soon', Number.NaN])('falls back to the global value for an unusable retryAfter %s', (retryAfter) => {
        const { log, warn } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local', retryAfter }, defaults(5_000), log)?.retryAfter).toBe(
            5_000,
        );
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"retryAfter"'));
    });

    it('maps schema issues to the host-specific Homebridge text', () => {
        const cases: Array<[RawDeviceEntry, string]> = [
            [{ host: 'esp-one.local', password: 42 }, 'The "password" configured for esp-one.local must be a string.'],
            [
                { host: 'esp-one.local', port: true },
                'The "port" configured for esp-one.local must be an integer between 1 and 65535.',
            ],
            [
                { host: 'esp-one.local', encryptionKey: 42 },
                'The "encryptionKey" configured for esp-one.local must be a string.',
            ],
        ];

        for (const [raw, message] of cases) {
            const { log, error } = createFakeLogging();
            expect(resolveDeviceConfig(raw, defaults(), log)).toBeUndefined();
            expect(error).toHaveBeenCalledWith(message);
        }
    });

    it('reports the first invalid field in config order when several fail', () => {
        const cases: Array<[RawDeviceEntry, string]> = [
            [{ host: '  ', password: 42 }, 'A "devices" entry is missing a valid "host"; skipping it.'],
            [
                { host: 'esp-one.local', password: 42, port: 70_000 },
                'The "password" configured for esp-one.local must be a string.',
            ],
            [
                { host: 'esp-one.local', port: 'abc', encryptionKey: 42 },
                'The "port" configured for esp-one.local must be an integer between 1 and 65535.',
            ],
        ];

        for (const [raw, message] of cases) {
            const { log, error } = createFakeLogging();
            expect(resolveDeviceConfig(raw, defaults(), log)).toBeUndefined();
            expect(error).toHaveBeenCalledWith(message);
        }
    });

    it('coerces a whitespace-padded numeric-string port', () => {
        const { log } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local', port: ' 6053 ' }, defaults(), log)?.port).toBe(6053);
    });

    it('ignores unknown keys instead of rejecting the entry', () => {
        const { log, error } = createFakeLogging();

        expect(resolveDeviceConfig({ host: 'esp-one.local', futureKey: 'value' }, defaults(), log)?.host).toBe(
            'esp-one.local',
        );
        expect(error).not.toHaveBeenCalled();
    });
});

describe('resolveDeviceConfigs', () => {
    it('validates every entry and drops only the invalid ones', () => {
        const { log, error } = createFakeLogging();

        const resolved = resolveDeviceConfigs(
            [{ host: 'one.local' }, { host: '' }, { host: 'two.local', port: 70000 }],
            defaults(),
            log,
        );

        expect(resolved.map(({ host }) => host)).toEqual(['one.local']);
        expect(error).toHaveBeenCalledTimes(2);
    });
});

describe('createDiscoveryConfigMerge', () => {
    it('merges a discovered service with its configured entry and uses the address', () => {
        const { log } = createFakeLogging();
        // The merge works on raw entries, so the configured values keep their raw shape.
        const rawConfigured = [{ host: 'esp-one.local', password: 'secret', encryptionKey: '  key  ', port: 7000 }];
        const merge = createDiscoveryConfigMerge(rawConfigured, defaults(), log);

        const merged = merge.merge({ host: 'esp-one.local', address: '10.0.0.5', port: 6053 });

        expect(merged).toMatchObject({
            host: '10.0.0.5',
            password: 'secret',
            encryptionKey: 'key',
            port: 7000,
        });
        expect(merge.remaining()).toEqual([]);
    });

    it('binds a discovered service without a configured entry using the defaults', () => {
        const { log } = createFakeLogging();
        const merge = createDiscoveryConfigMerge([], defaults(5_000), log);

        expect(merge.merge({ host: 'esp-one.local', address: '10.0.0.9', port: 6053 })).toEqual({
            host: '10.0.0.9',
            password: undefined,
            port: 6053,
            encryptionKey: undefined,
            retryAfter: 5_000,
            invertFanDirection: false,
        });
    });

    it('returns configured entries discovery did not find', () => {
        const { log } = createFakeLogging();
        const rawConfigured = [{ host: 'conf.local', port: 7000 }, { host: 'other.local' }];
        const merge = createDiscoveryConfigMerge(rawConfigured, defaults(), log);

        merge.merge({ host: 'conf.local', address: '10.0.0.5' });

        expect(merge.remaining()).toEqual([
            {
                host: 'other.local',
                password: undefined,
                port: undefined,
                encryptionKey: undefined,
                retryAfter: DEFAULT_RETRY_AFTER,
                invertFanDirection: false,
            },
        ]);
    });

    it('validates the merged entry, so an invalid configured field still drops the Device', () => {
        const { log, error } = createFakeLogging();
        const merge = createDiscoveryConfigMerge([{ host: 'esp-one.local', port: 70000 }], defaults(), log);

        expect(merge.merge({ host: 'esp-one.local', address: '10.0.0.5', port: 6053 })).toBeUndefined();
        expect(error).toHaveBeenCalledWith(expect.stringContaining('"port"'));
        expect(merge.remaining()).toEqual([]);
    });

    it('treats each discovered hostname as matched independently', () => {
        const { log } = createFakeLogging();
        const merge = createDiscoveryConfigMerge([{ host: 'one.local' }, { host: 'two.local' }], defaults(), log);

        merge.merge({ host: 'one.local' });
        merge.merge({ host: 'two.local' });

        expect(merge.remaining()).toEqual([]);
    });
});
