import * as net from 'net';
import * as dgram from 'dgram';
import {
    USHRT_MAX,
    MACHINE_PREPARE_DATA_1,
    MACHINE_PREPARE_DATA_2,
    CMD_PREPARE_BUFFER,
    CMD_DATA,
    CMD_PREPARE_DATA,
    CMD_ACK_OK,
    CMD_READ_BUFFER,
    CMD_FREE_DATA
} from '../others/constants.js';
import { createHeader, createTcpTop, removeNull } from '../utils/utils.js';
import { ZKTecoClient } from '../objects/zkTecoClient.js';
import type { ZKTecoAttendance, FlushOptions } from '../others/interfaces.js';

export interface LivePacket {
    header: Buffer;
    payload: Buffer;
    command: number;
}

export async function createSocket(ip: string, port: number, timeout: number, forceUdp: boolean, client: ZKTecoClient): Promise<net.Socket | dgram.Socket> {
    return new Promise((resolve, reject) => {
        if (!client.forceUdp) {
            const socket = new net.Socket();
            socket.setTimeout(timeout);

            socket.connect(port, ip, () => {
                resolve(socket);
            });

            socket.on('error', (err: Error) => {
                console.error('Socket error:', err);
                reject(err);
            });

            socket.on('timeout', () => {
                reject(new Error('Connection timed out'));
            });
        } else {
            const socket = dgram.createSocket('udp4');
            resolve(socket); // UDP is connectionless
        }
    });
}

export function closeSocket(client: ZKTecoClient) {
    if (client.socket) {
        if (client.socket instanceof net.Socket) {
            client.socket.destroy();
        } else {
            client.socket.close();
        }
    }
}

export async function sendCommand(command: number, commandString: Buffer, responseSize: number, client: ZKTecoClient): Promise<Buffer | null> {
    if (!client.socket) throw new Error('Socket not initialized');

    client.replyId++;
    if (client.replyId >= USHRT_MAX) client.replyId = 0;

    const packet = createHeader(command, commandString, client.sessionId, client.replyId);

    if (client.socket instanceof net.Socket) {
        const tcpPacket = createTcpTop(packet);

        return new Promise((resolve, reject) => {
            let timeoutId: NodeJS.Timeout;

            const cleanup = () => {
                client.socket?.removeListener('data', onData);
                client.socket?.removeListener('error', onError);
                client.socket?.removeListener('close', onClose);
                clearTimeout(timeoutId);
            };

            const onData = (data: Buffer) => {
                if (data.length >= 8) {
                    const header1 = data.readUInt16LE(0);
                    const header2 = data.readUInt16LE(2);

                    if (header1 === MACHINE_PREPARE_DATA_1 && header2 === MACHINE_PREPARE_DATA_2) {
                        // Store state for readWithBuffer
                        client.tcpLength = data.readUInt32LE(4);

                        // Extract payload (skip 8 byte TCP header)
                        const payload = data.subarray(8);

                        if (payload.length >= 8) {
                            // Store response code and data
                            client.lastResponse = payload.readUInt16LE(0);
                            client.lastData = payload.subarray(8);
                        } else {
                            client.lastResponse = 0;
                            client.lastData = Buffer.alloc(0);
                        }

                        cleanup();
                        resolve(payload);
                    }
                }
            };

            const onError = (err: Error) => {
                cleanup();
                reject(err);
            };

            const onClose = () => {
                cleanup();
                reject(new Error('Socket closed'));
            };

            // Set a timeout for the command response
            timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('Command timeout'));
            }, 2000); // 2 seconds timeout for command response

            client.socket?.on('data', onData);
            client.socket?.on('error', onError);
            client.socket?.on('close', onClose);

            (client.socket as any).write(tcpPacket, (err: Error | null) => {
                if (err) {
                    cleanup();
                    reject(err);
                }
            });
        });
    } else {
        return new Promise((resolve, reject) => {
            const socket = client.socket as dgram.Socket;
            let timeoutId: NodeJS.Timeout;

            const cleanup = () => {
                socket.removeListener('message', onMessage);
                socket.removeListener('error', onError);
                clearTimeout(timeoutId);
            };

            const onMessage = (msg: Buffer) => {
                if (msg.length >= 8) {
                    client.lastResponse = msg.readUInt16LE(0);
                    client.lastData = msg.subarray(8);
                } else {
                    client.lastResponse = 0;
                    client.lastData = Buffer.alloc(0);
                }
                cleanup();
                resolve(msg);
            };

            const onError = (err: Error) => {
                cleanup();
                reject(err);
            };

            timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('Command timeout'));
            }, 2000);

            socket.on('message', onMessage);
            socket.on('error', onError);

            socket.send(packet, client.port, client.ip, (err: Error | null) => {
                if (err) {
                    cleanup();
                    reject(err);
                }
            });
        });
    }
}

export async function readSizes(client: ZKTecoClient): Promise<void> {
    if (client.verbose) console.log('Reading sizes...');
    const memInfo = await client.getMemoryInfo();
    if (memInfo) {
        if (client.verbose) console.log('Sizes read:', memInfo);
        client.users = memInfo.usedUsers;
        client.fingers = memInfo.usedFingers;
        client.records = memInfo.usedRecords;
        client.usersCapacity = memInfo.totalUsers;
        client.fingersCapacity = memInfo.totalFingers;
        client.recordsCapacity = memInfo.totalRecords;
    }
}

export async function readWithBuffer(command: number, fct: number = 0, ext: number = 0, client: ZKTecoClient): Promise<{ data: Buffer, size: number }> {
    const commandString = Buffer.alloc(11);
    commandString.writeUInt8(1, 0);
    commandString.writeUInt16LE(command, 1);
    commandString.writeUInt32LE(fct, 3);
    commandString.writeUInt32LE(ext, 7);

    const response = await sendCommand(CMD_PREPARE_BUFFER, commandString, 1024, client);

    if (!response) {
        throw new Error('RWB Not supported');
    }

    const MAX_CHUNK = (!client.forceUdp && client.socket instanceof net.Socket) ? 0xFFc0 : 16 * 1024;

    // Handle CMD_DATA response directly (e.g. small data)
    if (client.lastResponse === CMD_DATA) {
        if (client.socket instanceof net.Socket && !client.forceUdp) {
            // TCP: Check if we have all data based on TCP length
            if (client.verbose) console.log(`DATA! is ${client.lastData.length} bytes, tcp length is ${client.tcpLength}`);

            if (client.lastData.length < (client.tcpLength - 8)) {
                const need = (client.tcpLength - 8) - client.lastData.length;
                if (client.verbose) console.log(`need more data: ${need}`);
                const moreData = await receiveRawData(need, client);
                const fullData = Buffer.concat([client.lastData, moreData]);
                return { data: fullData, size: fullData.length };
            } else {
                if (client.verbose) console.log('Enough data');
                return { data: client.lastData, size: client.lastData.length };
            }
        } else {
            // UDP
            return { data: client.lastData, size: client.lastData.length };
        }
    }

    // Handle CMD_PREPARE_DATA response (large data, need to read chunks)
    // Python uses offset 1: size = unpack('I', self.__data[1:5])[0]
    // The first byte is a flag/command byte
    if (client.lastData.length < 5) {
        throw new Error('Invalid PREPARE_DATA response: too small');
    }

    const dataSize = client.lastData.readUInt32LE(1); // Python uses offset 1!
    if (client.verbose) console.log(`size will be ${dataSize}`);

    let data = Buffer.alloc(0);
    let start = 0;

    const remain = dataSize % MAX_CHUNK;
    const packets = Math.floor((dataSize - remain) / MAX_CHUNK);

    if (client.verbose) console.log(`rwb: #${packets} packets of max ${MAX_CHUNK} bytes, and extra ${remain} bytes remain`);

    for (let i = 0; i < packets; i++) {
        const chunk = await readChunk(start, MAX_CHUNK, client);
        data = Buffer.concat([data, chunk]);
        start += MAX_CHUNK;
    }

    if (remain > 0) {
        const chunk = await readChunk(start, remain, client);
        data = Buffer.concat([data, chunk]);
        start += remain;
    }

    await freeData(client);

    if (client.verbose) console.log(`_read w/chunk ${start} bytes`);

    return { data, size: start };
}

export async function receiveRawData(size: number, client: ZKTecoClient): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        if (!client.socket || !(client.socket instanceof net.Socket)) {
            reject(new Error('Socket not available for receiveRawData'));
            return;
        }

        const socket = client.socket;
        let received = Buffer.alloc(0);
        let remaining = size;

        const onData = (data: Buffer) => {
            received = Buffer.concat([received, data]);
            remaining -= data.length;

            if (client.verbose) console.log(`receiveRawData: received ${data.length}, remaining ${remaining}`);

            if (remaining <= 0) {
                socket.removeListener('data', onData);
                socket.removeListener('error', onError);
                resolve(received.subarray(0, size));
            }
        };

        const onError = (err: Error) => {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            reject(err);
        };

        socket.on('data', onData);
        socket.on('error', onError);

        // Set a timeout
        setTimeout(() => {
            if (remaining > 0) {
                socket.removeListener('data', onData);
                socket.removeListener('error', onError);
                reject(new Error(`receiveRawData timeout, still need ${remaining} bytes`));
            }
        }, 5000);
    });
}

export function getDataSize(client: ZKTecoClient): number {
    if (client.lastResponse === CMD_PREPARE_DATA) {
        if (client.lastData.length >= 4) {
            return client.lastData.readUInt32LE(0);
        }
    }
    return 0;
}

export async function receiveChunk(client: ZKTecoClient): Promise<Buffer> {
    // Handle CMD_DATA response
    if (client.lastResponse === CMD_DATA) {
        if (!client.forceUdp && client.socket instanceof net.Socket) {
            if (client.verbose) console.log(`_rc_DATA! is ${client.lastData.length} bytes, tcp length is ${client.tcpLength}`);

            if (client.lastData.length < (client.tcpLength - 8)) {
                const need = (client.tcpLength - 8) - client.lastData.length;
                if (client.verbose) console.log(`need more data: ${need}`);

                const moreData = await receiveRawData(need, client);
                return Buffer.concat([client.lastData, moreData]);
            } else {
                if (client.verbose) console.log('Enough data');
                return client.lastData;
            }
        } else {
            // UDP case
            if (client.verbose) console.log(`_rc len is ${client.lastData.length}`);
            return client.lastData;
        }
    }
    // Handle CMD_PREPARE_DATA response
    else if (client.lastResponse === CMD_PREPARE_DATA) {
        const size = getDataSize(client);
        if (client.verbose) console.log(`receive chunk: prepare data size is ${size}`);

        if (!client.forceUdp && client.socket instanceof net.Socket) {
            // TCP case
            let dataRecv: Buffer;

            if (client.lastData.length >= (8 + size)) {
                dataRecv = client.lastData.subarray(8);
            } else {
                const additionalData = await receiveRawData(size + 32, client);
                dataRecv = Buffer.concat([client.lastData.subarray(8), additionalData]);
            }

            // For simplicity, assuming data arrives correctly
            // Full implementation would call receiveTcpData here
            // For now, just return the data portion
            return dataRecv.subarray(0, size);
        } else {
            // UDP case - receive multiple packets
            const data: Buffer[] = [];
            let remaining = size;

            while (true) {
                const dataRecv = await receiveRawData(1024 + 8, client);

                if (dataRecv.length < 8) break;

                const response = dataRecv.readUInt16LE(0);
                if (client.verbose) console.log(`# packet response is: ${response}`);

                if (response === CMD_DATA) {
                    data.push(dataRecv.subarray(8));
                    remaining -= 1024;
                } else if (response === CMD_ACK_OK) {
                    break;
                } else {
                    if (client.verbose) console.log('broken!');
                    break;
                }

                if (client.verbose) console.log(`still needs ${remaining}`);
                if (remaining <= 0) break;
            }

            return Buffer.concat(data);
        }
    } else {
        if (client.verbose) console.log(`invalid response ${client.lastResponse}`);
        return Buffer.alloc(0);
    }
}

export async function readChunk(start: number, size: number, client: ZKTecoClient): Promise<Buffer> {
    for (let retries = 0; retries < 3; retries++) {
        try {
            const commandString = Buffer.alloc(8);
            commandString.writeInt32LE(start, 0);
            commandString.writeInt32LE(size, 4);

            const responseSize = (!client.forceUdp && client.socket instanceof net.Socket) ? size + 32 : 1024 + 8;
            await sendCommand(CMD_READ_BUFFER, commandString, responseSize, client);

            // Call receiveChunk to process the response
            const data = await receiveChunk(client);

            if (data.length > 0) {
                return data;
            }

            if (client.verbose) console.log(`ReadChunk: receiveChunk returned empty data on retry ${retries}`);
        } catch (e) {
            if (client.verbose) console.log(`ReadChunk retry ${retries}:`, e);
        }
    }
    throw new Error(`Can't read chunk ${start}:[${size}]`);
}

export async function freeData(client: ZKTecoClient): Promise<void> {
    await sendCommand(CMD_FREE_DATA, Buffer.alloc(0), 1024, client);
}

export async function sendAckOnly(client: ZKTecoClient, receivedHeader: Buffer | null = null): Promise<void> {
    if (!client.socket) return;

    let ackSessionId = client.sessionId;
    let ackReplyId = USHRT_MAX - 1;

    if (receivedHeader && receivedHeader.length >= 8) {
        ackSessionId = receivedHeader.readUInt16LE(4);
        ackReplyId = receivedHeader.readUInt16LE(6);
    }

    const packet = createHeader(CMD_ACK_OK, Buffer.alloc(0), ackSessionId, ackReplyId);

    await new Promise<void>((resolve) => {
        try {
            if (client.socket instanceof net.Socket && !client.forceUdp) {
                const tcpPacket = createTcpTop(packet);
                client.socket.write(tcpPacket, () => resolve());
            } else if (client.socket instanceof dgram.Socket) {
                client.socket.send(packet, client.port, client.ip, () => resolve());
            } else {
                resolve();
            }
        } catch {
            resolve();
        }
    });
}

export async function receiveLivePacket(
    client: ZKTecoClient,
    timeoutMs: number = 1000
): Promise<LivePacket | null> {
    if (!client.socket) throw new Error('Socket not initialized');

    const cleanupTcp = (socket: net.Socket, handlers: { data: (chunk: Buffer) => void; error: () => void; close: () => void }, timer: NodeJS.Timeout) => {
        socket.removeListener('data', handlers.data);
        socket.removeListener('error', handlers.error);
        socket.removeListener('close', handlers.close);
        clearTimeout(timer);
    };

    if (client.socket instanceof net.Socket && !client.forceUdp) {
        const pendingPacket = consumePendingTcpPacket(client);
        if (pendingPacket) {
            return pendingPacket;
        }

        const socket = client.socket;
        return new Promise<LivePacket | null>((resolve) => {
            let buffer = client.pendingLiveData && client.pendingLiveData.length > 0
                ? client.pendingLiveData
                : Buffer.alloc(0);
            client.pendingLiveData = Buffer.alloc(0);
            let expectedLength = 0;
            const timer = setTimeout(() => {
                cleanupTcp(socket, handlers, timer);
                if (buffer.length > 0) {
                    client.pendingLiveData = Buffer.from(buffer);
                }
                resolve(null);
            }, timeoutMs);

            const finish = (result: LivePacket | null) => {
                if (result && expectedLength > 0 && buffer.length > expectedLength) {
                    client.pendingLiveData = Buffer.from(buffer.subarray(expectedLength));
                } else if (!result && buffer.length > 0) {
                    client.pendingLiveData = Buffer.from(buffer);
                } else {
                    client.pendingLiveData = Buffer.alloc(0);
                }
                cleanupTcp(socket, handlers, timer);
                resolve(result);
            };

            const handlers = {
                data: (chunk: Buffer) => {
                    buffer = Buffer.concat([buffer, chunk]);
                    if (expectedLength === 0 && buffer.length >= 8) {
                        const header1 = buffer.readUInt16LE(0);
                        const header2 = buffer.readUInt16LE(2);

                        if (header1 !== MACHINE_PREPARE_DATA_1 || header2 !== MACHINE_PREPARE_DATA_2) {
                            finish(null);
                            return;
                        }

                        expectedLength = buffer.readUInt32LE(4) + 8;
                    }

                    if (expectedLength > 0 && buffer.length >= expectedLength) {
                        const packet = extractLivePacket(buffer.subarray(0, expectedLength), 8);
                        finish(packet);
                    }
                },
                error: () => finish(null),
                close: () => finish(null)
            };

            socket.on('data', handlers.data);
            socket.on('error', handlers.error);
            socket.on('close', handlers.close);
        });
    }

    if (client.socket instanceof dgram.Socket) {
        const socket = client.socket;
        return new Promise<LivePacket | null>((resolve) => {
            let timer = setTimeout(() => {
                cleanupUdp();
                resolve(null);
            }, timeoutMs);

            const cleanupUdp = () => {
                socket.off('message', onMessage);
                socket.off('error', onError);
                clearTimeout(timer);
            };

            const onMessage = (msg: Buffer) => {
                cleanupUdp();
                resolve(extractLivePacket(msg, 0));
            };

            const onError = () => {
                cleanupUdp();
                resolve(null);
            };

            socket.on('message', onMessage);
            socket.on('error', onError);
        });
    }

    return null;
}

export async function flushExistingEvents(client: ZKTecoClient, options: FlushOptions = {}): Promise<number> {
    const {
        timeoutMs = 200,
        maxPackets = 10,
        verbose = false
    } = options;

    let flushed = 0;
    while (flushed < maxPackets) {
        const packet = await receiveLivePacket(client, timeoutMs);
        if (!packet) {
            break;
        }

        flushed++;
        await sendAckOnly(client, packet.header);

        if (verbose) {
            console.log(`Flushed live packet (${packet.payload.length} bytes)`);
        }
    }

    return flushed;
}

export function processLiveEventBuffer(
    buffer: Buffer,
    userLookup: Map<string, number>,
    verbose: boolean = false
): { events: ZKTecoAttendance[]; remainder: Buffer } {
    const events: ZKTecoAttendance[] = [];
    let workingBuffer = buffer;

    while (workingBuffer.length >= 10) {
        const eventSize = determineEventSize(workingBuffer.length);
        if (eventSize === 0 || workingBuffer.length < eventSize) {
            break;
        }

        const eventChunk = workingBuffer.subarray(0, eventSize);
        const attendance = parseLiveEventData(eventChunk, userLookup, verbose);
        if (attendance) {
            events.push(attendance);
        }
        workingBuffer = workingBuffer.subarray(eventSize);
    }

    return { events, remainder: workingBuffer };
}

function extractLivePacket(packet: Buffer, headerOffset: number): LivePacket | null {
    if (packet.length < headerOffset + 8) {
        return null;
    }

    const header = packet.subarray(headerOffset, headerOffset + 8);
    const payload = packet.subarray(headerOffset + 8);
    const command = header.length >= 2 ? header.readUInt16LE(0) : 0;

    return { header, payload, command };
}

function consumePendingTcpPacket(client: ZKTecoClient): LivePacket | null {
    const pending = client.pendingLiveData;
    if (!pending || pending.length < 8) {
        return null;
    }

    const header1 = pending.readUInt16LE(0);
    const header2 = pending.readUInt16LE(2);
    if (header1 !== MACHINE_PREPARE_DATA_1 || header2 !== MACHINE_PREPARE_DATA_2) {
        client.pendingLiveData = Buffer.alloc(0);
        return null;
    }

    const expectedLength = pending.readUInt32LE(4) + 8;
    if (pending.length < expectedLength) {
        return null;
    }

    const packet = extractLivePacket(pending.subarray(0, expectedLength), 8);
    client.pendingLiveData = pending.length > expectedLength
        ? Buffer.from(pending.subarray(expectedLength))
        : Buffer.alloc(0);

    return packet;
}

function determineEventSize(bufferLength: number): number {
    if (bufferLength === 10 || bufferLength === 12 || bufferLength === 14 ||
        bufferLength === 32 || bufferLength === 36 || bufferLength === 37) {
        return bufferLength;
    }

    if (bufferLength >= 52) return 52;
    if (bufferLength >= 37) return 37;
    if (bufferLength >= 36) return 36;
    if (bufferLength >= 32) return 32;
    if (bufferLength >= 14) return 14;
    if (bufferLength >= 12) return 12;
    if (bufferLength >= 10) return 10;

    return 0;
}

function parseLiveEventData(
    data: Buffer,
    userLookup: Map<string, number>,
    verbose: boolean
): ZKTecoAttendance | null {
    let userId = '';
    let status = 0;
    let punch = 0;
    let timeBytes: Buffer | null = null;

    if (data.length === 10 || data.length === 14) {
        const userIdInt = data.readUInt16LE(0);
        userId = userIdInt.toString();
        status = data.readUInt8(2);
        punch = data.readUInt8(3);
        timeBytes = data.subarray(4, 10);
    } else if (data.length === 12) {
        const userIdInt = data.readUInt32LE(0);
        userId = userIdInt.toString();
        status = data.readUInt8(4);
        punch = data.readUInt8(5);
        timeBytes = data.subarray(6, 12);
    } else if (data.length === 32 || data.length === 36 || data.length === 37 || data.length >= 52) {
        userId = removeNull(data.subarray(0, 24).toString());
        status = data.readUInt8(24);
        punch = data.readUInt8(25);
        timeBytes = data.subarray(26, 32);
    } else {
        if (verbose) {
            console.warn(`Unrecognized live event size: ${data.length}`);
        }
        return null;
    }

    if (!userId || !timeBytes || timeBytes.length < 6) {
        return null;
    }

    const timestamp = decodeLiveTimestamp(timeBytes);
    let uid = userLookup.get(userId) ?? 0;

    if (uid === 0) {
        const parsedUid = parseInt(userId, 10);
        if (!Number.isNaN(parsedUid)) {
            uid = parsedUid;
        }
    }

    return {
        userId,
        uid,
        status,
        punch,
        timestamp
    };
}

function decodeLiveTimestamp(timeBytes: Buffer): Date {
    const year = timeBytes.readUInt8(0);
    const month = timeBytes.readUInt8(1);
    const day = timeBytes.readUInt8(2);
    const hour = timeBytes.readUInt8(3);
    const minute = timeBytes.readUInt8(4);
    const second = timeBytes.readUInt8(5);

    const fullYear = 2000 + year;
    const isValidDate =
        month >= 1 && month <= 12 &&
        day >= 1 && day <= 31 &&
        hour < 24 &&
        minute < 60 &&
        second < 60;

    if (!isValidDate) {
        return new Date(2000, 0, 1);
    }

    return new Date(fullYear, month - 1, day, hour, minute, second);
}