import { Buffer } from 'buffer';
export declare const createChecksum: (packet: Buffer) => number;
export declare const createHeader: (command: number, commandString: Buffer, sessionId: number, replyId: number) => Buffer;
export declare const createTcpTop: (packet: Buffer) => Buffer;
export declare const testTcpTop: (packet: Buffer) => number;
export declare const makeCommKey: (key: number, sessionId: number, ticks?: number) => Buffer;
export declare const decodeTime: (timeBytes: Buffer) => Date;
export declare const encodeTime: (date: Date) => number;
export declare const removeNull: (str: string) => string;
//# sourceMappingURL=utils.d.ts.map