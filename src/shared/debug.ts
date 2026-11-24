import type { EspDevice, ReadData } from 'esphome-ts';
import { isRecord } from './typeguards.js';
import { EspSocket } from 'esphome-ts';
import { concatMap, map } from 'rxjs';
import { existsSync, promises as fs } from 'fs';
import type { Observable, Subscription } from 'rxjs';
import { from } from 'rxjs';
import { randomBytes } from 'node:crypto';
import { join } from 'path';

/**
 * Mirror every frame the device sends into a `/tmp` JSON-lines dump.
 *
 * Best-effort by contract: a failed append (full disk, read-only `/tmp`) ends the dump for
 * that device instead of escaping as an unhandled RxJS error, which Homebridge's process
 * handler turns into a bridge restart. The returned subscription is the teardown handle and
 * belongs to the caller (CODING_STANDARDS: every subscription has an owner); `onWriteError`
 * reports the one failure so the caller can tell the user why dumps stopped.
 *
 * @returns The dump subscription, or `undefined` when the device exposes no socket to tap.
 */
export const writeReadDataToLogFile = (
    host: string,
    device: EspDevice,
    onWriteError?: (error: unknown) => void,
): Subscription | undefined => {
    const espDevice: unknown = device;
    if (existsSync(join('/tmp')) && isRecord(espDevice) && espDevice.socket instanceof EspSocket) {
        const socket: EspSocket = espDevice.socket;
        // The host may come from a hand-edited config or mDNS; keep it from steering the
        // filename outside /tmp. A non-string host is a config error the platform rejects
        // before calling this, but the dump must not be the thing that throws.
        const rawHost: unknown = host;
        const safeHost = typeof rawHost === 'string' ? rawHost.replace(/[^A-Za-z0-9._:-]/g, '_') : 'unknown';
        // The random suffix keeps the name from being predictable on a shared host, so a
        // pre-created file cannot capture the decrypted frames. `mode` applies on creation.
        const fileName = `esphome-log-${Date.now()}-${randomBytes(4).toString('hex')}-${safeHost}.json`;
        return socket.espData$
            .pipe(
                map((data: ReadData): Record<string, string | number> => ({
                    type: data.type,
                    payload: Buffer.from(data.payload).toString('base64'),
                    time: Date.now(),
                })),
                concatMap((data: Record<string, string | number>): Observable<void> =>
                    from(
                        fs.appendFile(join('/tmp', fileName), `${JSON.stringify(data)}\n`, {
                            mode: 0o600,
                        }),
                    ),
                ),
            )
            .subscribe({
                error: (error: unknown) => {
                    try {
                        onWriteError?.(error);
                    } catch {
                        // A failing reporter must not defeat the containment this seam exists for.
                    }
                },
            });
    }
    return undefined;
};
