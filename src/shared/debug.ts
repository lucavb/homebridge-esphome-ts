import type { EspDevice, ReadData } from 'esphome-ts';
import { isRecord } from './typeguards.js';
import { EspSocket } from 'esphome-ts';
import { concatMap, map } from 'rxjs';
import { existsSync, promises as fs } from 'fs';
import { from, Observable } from 'rxjs';
import { join } from 'path';

export const writeReadDataToLogFile = (host: string, device: EspDevice): void => {
    const espDevice: unknown = device;
    if (existsSync(join('/tmp')) && isRecord(espDevice) && espDevice.socket instanceof EspSocket) {
        const socket: EspSocket = espDevice.socket;
        const fileName = `esphome-log-${Date.now()}-${host}.json`;
        socket.espData$
            .pipe(
                map((data: ReadData): Record<string, string | number> => ({
                    type: data.type,
                    payload: Buffer.from(data.payload).toString('base64'),
                    time: Date.now(),
                })),
                concatMap((data: Record<string, string | number>): Observable<void> =>
                    from(fs.appendFile(join('/tmp', fileName), `${JSON.stringify(data)}\n`)),
                ),
            )
            .subscribe();
    }
};
