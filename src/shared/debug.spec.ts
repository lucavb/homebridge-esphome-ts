import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { of, Subject } from 'rxjs';
import { EspSocket } from 'esphome-ts';
import type { EspDevice } from 'esphome-ts';
import { ok } from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeReadDataToLogFile } from './debug.js';

interface Frame {
    readonly type: number;
    readonly payload: Uint8Array;
}

const makeDevice = (): EspDevice => {
    const socket = Object.create(EspSocket.prototype) as EspSocket;
    Object.defineProperty(socket, 'espData$', {
        value: of({ type: 1, payload: new Uint8Array([1, 2]) }),
    });
    return { socket } as unknown as EspDevice;
};

/** A device whose frame stream stays open, so the dump subscription can be torn down. */
const makeStreamingDevice = (): { device: EspDevice; frames: Subject<Frame> } => {
    const frames = new Subject<Frame>();
    const socket = Object.create(EspSocket.prototype) as EspSocket;
    Object.defineProperty(socket, 'espData$', {
        value: frames.asObservable(),
    });
    return { device: { socket } as unknown as EspDevice, frames };
};

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe('writeReadDataToLogFile', () => {
    it('writes decrypted frames with owner-only permissions', async () => {
        const appendFile = vi.spyOn(fs, 'appendFile').mockResolvedValue();

        const subscription = writeReadDataToLogFile('esp-one.local', makeDevice());
        await flush();

        expect(appendFile).toHaveBeenCalledWith(expect.stringContaining('esphome-log-'), expect.any(String), {
            mode: 0o600,
        });
        expect(subscription).toBeDefined();
    });

    it('keeps a hostile host inside the generated filename', async () => {
        const appendFile = vi.spyOn(fs, 'appendFile').mockResolvedValue();

        writeReadDataToLogFile('../../evil', makeDevice());
        await flush();

        const [fileName] = appendFile.mock.calls[0] ?? [];
        expect(fileName).toContain('esphome-log-');
        expect(dirname(fileName as string)).toBe('/tmp');
        expect(fileName).not.toContain('../');
        expect(fileName).not.toContain('/evil');
    });

    it('uses a fresh unpredictable filename for every dump', async () => {
        const appendFile = vi.spyOn(fs, 'appendFile').mockResolvedValue();

        writeReadDataToLogFile('esp-one.local', makeDevice());
        writeReadDataToLogFile('esp-one.local', makeDevice());
        await flush();

        const names = appendFile.mock.calls.map(([fileName]) => String(fileName));
        expect(new Set(names).size).toBe(2);
        for (const name of names) {
            expect(name).toMatch(/esphome-log-\d+-[0-9a-f]{8}-/);
        }
    });

    it('returns undefined when the device exposes no socket to tap', () => {
        expect(writeReadDataToLogFile('esp-one.local', {} as EspDevice)).toBeUndefined();
    });

    it('contains a failed write even without an error reporter', async () => {
        vi.spyOn(fs, 'appendFile').mockRejectedValue(new Error('EACCES: permission denied'));

        const subscription = writeReadDataToLogFile('esp-one.local', makeDevice());
        await flush();

        expect(subscription?.closed).toBe(true);
    });

    it('does not let a throwing error reporter escape', async () => {
        vi.spyOn(fs, 'appendFile').mockRejectedValue(new Error('ENOSPC: no space left on device'));
        const onWriteError = vi.fn(() => {
            throw new Error('logger exploded');
        });

        const subscription = writeReadDataToLogFile('esp-one.local', makeDevice(), onWriteError);
        await flush();

        expect(onWriteError).toHaveBeenCalledTimes(1);
        expect(subscription?.closed).toBe(true);
    });

    it('stops after the first failed write and reports it once', async () => {
        const appendFile = vi
            .spyOn(fs, 'appendFile')
            .mockResolvedValueOnce()
            .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
        const onWriteError = vi.fn();
        const { device, frames } = makeStreamingDevice();

        const subscription = writeReadDataToLogFile('esp-one.local', device, onWriteError);
        ok(subscription);
        frames.next({ type: 1, payload: new Uint8Array([1]) });
        frames.next({ type: 1, payload: new Uint8Array([2]) });
        await flush();
        expect(appendFile).toHaveBeenCalledTimes(2);
        expect(onWriteError).toHaveBeenCalledTimes(1);
        expect(subscription.closed).toBe(true);

        frames.next({ type: 1, payload: new Uint8Array([3]) });
        await flush();
        expect(appendFile).toHaveBeenCalledTimes(2);
    });

    it('contains a failed write instead of letting it escape as an unhandled error', async () => {
        vi.spyOn(fs, 'appendFile').mockRejectedValue(new Error('ENOSPC: no space left on device'));
        const onWriteError = vi.fn();

        const subscription = writeReadDataToLogFile('esp-one.local', makeDevice(), onWriteError);
        await flush();

        // The dump is best-effort: report once, end the chain, and never reach the process
        // handler that would restart the bridge.
        expect(onWriteError).toHaveBeenCalledTimes(1);
        expect(subscription?.closed).toBe(true);
    });

    it('returns the subscription that owns the dump, so the caller can stop it', async () => {
        const appendFile = vi.spyOn(fs, 'appendFile').mockResolvedValue();
        const { device, frames } = makeStreamingDevice();

        const subscription = writeReadDataToLogFile('esp-one.local', device);
        ok(subscription);
        frames.next({ type: 1, payload: new Uint8Array([1]) });
        await flush();
        expect(appendFile).toHaveBeenCalledTimes(1);

        subscription.unsubscribe();
        frames.next({ type: 1, payload: new Uint8Array([2]) });
        await flush();
        expect(appendFile).toHaveBeenCalledTimes(1);
    });
});
