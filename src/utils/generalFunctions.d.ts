import * as net from 'net';
import * as dgram from 'dgram';
import { ZKTecoClient } from '../objects/zkTecoClient.js';
export declare function createSocket(ip: string, port: number, timeout: number, forceUdp: boolean, client: ZKTecoClient): Promise<net.Socket | dgram.Socket>;
export declare function closeSocket(client: ZKTecoClient): void;
export declare function sendCommand(command: number, commandString: Buffer, responseSize: number, client: ZKTecoClient): Promise<Buffer | null>;
export declare function readSizes(client: ZKTecoClient): Promise<void>;
export declare function readWithBuffer(command: number, fct: number | undefined, ext: number | undefined, client: ZKTecoClient): Promise<{
    data: Buffer;
    size: number;
}>;
export declare function receiveRawData(size: number, client: ZKTecoClient): Promise<Buffer>;
export declare function getDataSize(client: ZKTecoClient): number;
export declare function receiveChunk(client: ZKTecoClient): Promise<Buffer>;
export declare function readChunk(start: number, size: number, client: ZKTecoClient): Promise<Buffer>;
export declare function freeData(client: ZKTecoClient): Promise<void>;
//# sourceMappingURL=generalFunctions.d.ts.map