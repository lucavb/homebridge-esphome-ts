import { existsSync, promises as fs } from 'fs';
import { join } from 'path';
import { EspDevice, ReadData } from 'esphome-ts';
import { EspSocket } from 'esphome-ts/dist/api/espSocket';
import { from, Observable, Subscription } from 'rxjs';
import { concatMap, map } from 'rxjs/operators';

import { isRecord } from './typeguards';

export const writeReadDataToLogFile = (host: string, device: EspDevice): Subscription | undefined => {
    const espDevice: unknown = device;
    if (!existsSync(join('/tmp')) || !isRecord(espDevice) || !(espDevice.socket instanceof EspSocket)) {
        return undefined;
    }

    const socket: EspSocket = espDevice.socket;
    const fileName = `esphome-log-${Date.now()}-${host}.json`;
    return socket.espData$
        .pipe(
            map(
                (data: ReadData): Record<string, string | number> => ({
                    type: data.type,
                    payload: Buffer.from(data.payload).toString('base64'),
                    time: Date.now(),
                }),
            ),
            concatMap(
                (data: Record<string, string | number>): Observable<void> =>
                    from(fs.appendFile(join('/tmp', fileName), `${JSON.stringify(data)}\n`)),
            ),
        )
        .subscribe();
};
