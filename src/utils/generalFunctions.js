import * as net from 'net';
import * as dgram from 'dgram';
import { USHRT_MAX, MACHINE_PREPARE_DATA_1, MACHINE_PREPARE_DATA_2, CMD_PREPARE_BUFFER, CMD_DATA, CMD_PREPARE_DATA, CMD_ACK_OK, CMD_READ_BUFFER, CMD_FREE_DATA } from '../others/constants.js';
import { createHeader, createTcpTop } from '../utils/utils.js';
import { ZKTecoClient } from '../objects/zkTecoClient.js';
export async function createSocket(ip, port, timeout, forceUdp, client) {
    return new Promise((resolve, reject) => {
        if (!client.forceUdp) {
            const socket = new net.Socket();
            socket.setTimeout(timeout);
            socket.connect(port, ip, () => {
                resolve(socket);
            });
            socket.on('error', (err) => {
                console.error('Socket error:', err);
                reject(err);
            });
            socket.on('timeout', () => {
                reject(new Error('Connection timed out'));
            });
        }
        else {
            const socket = dgram.createSocket('udp4');
            resolve(socket); // UDP is connectionless
        }
    });
}
export function closeSocket(client) {
    if (client.socket) {
        if (client.socket instanceof net.Socket) {
            client.socket.destroy();
        }
        else {
            client.socket.close();
        }
    }
}
export async function sendCommand(command, commandString, responseSize, client) {
    if (!client.socket)
        throw new Error('Socket not initialized');
    client.replyId++;
    if (client.replyId >= USHRT_MAX)
        client.replyId = 0;
    const packet = createHeader(command, commandString, client.sessionId, client.replyId);
    if (client.socket instanceof net.Socket) {
        const tcpPacket = createTcpTop(packet);
        return new Promise((resolve, reject) => {
            let timeoutId;
            const cleanup = () => {
                client.socket?.removeListener('data', onData);
                client.socket?.removeListener('error', onError);
                client.socket?.removeListener('close', onClose);
                clearTimeout(timeoutId);
            };
            const onData = (data) => {
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
                        }
                        else {
                            client.lastResponse = 0;
                            client.lastData = Buffer.alloc(0);
                        }
                        cleanup();
                        resolve(payload);
                    }
                }
            };
            const onError = (err) => {
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
            client.socket.write(tcpPacket, (err) => {
                if (err) {
                    cleanup();
                    reject(err);
                }
            });
        });
    }
    else {
        return new Promise((resolve, reject) => {
            const socket = client.socket;
            let timeoutId;
            const cleanup = () => {
                socket.removeListener('message', onMessage);
                socket.removeListener('error', onError);
                clearTimeout(timeoutId);
            };
            const onMessage = (msg) => {
                if (msg.length >= 8) {
                    client.lastResponse = msg.readUInt16LE(0);
                    client.lastData = msg.subarray(8);
                }
                else {
                    client.lastResponse = 0;
                    client.lastData = Buffer.alloc(0);
                }
                cleanup();
                resolve(msg);
            };
            const onError = (err) => {
                cleanup();
                reject(err);
            };
            timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('Command timeout'));
            }, 2000);
            socket.on('message', onMessage);
            socket.on('error', onError);
            socket.send(packet, client.port, client.ip, (err) => {
                if (err) {
                    cleanup();
                    reject(err);
                }
            });
        });
    }
}
export async function readSizes(client) {
    if (client.verbose)
        console.log('Reading sizes...');
    const memInfo = await client.getMemoryInfo();
    if (memInfo) {
        if (client.verbose)
            console.log('Sizes read:', memInfo);
        client.users = memInfo.usedUsers;
        client.fingers = memInfo.usedFingers;
        client.records = memInfo.usedRecords;
        client.usersCapacity = memInfo.totalUsers;
        client.fingersCapacity = memInfo.totalFingers;
        client.recordsCapacity = memInfo.totalRecords;
    }
}
export async function readWithBuffer(command, fct = 0, ext = 0, client) {
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
            if (client.verbose)
                console.log(`DATA! is ${client.lastData.length} bytes, tcp length is ${client.tcpLength}`);
            if (client.lastData.length < (client.tcpLength - 8)) {
                const need = (client.tcpLength - 8) - client.lastData.length;
                if (client.verbose)
                    console.log(`need more data: ${need}`);
                const moreData = await receiveRawData(need, client);
                const fullData = Buffer.concat([client.lastData, moreData]);
                return { data: fullData, size: fullData.length };
            }
            else {
                if (client.verbose)
                    console.log('Enough data');
                return { data: client.lastData, size: client.lastData.length };
            }
        }
        else {
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
    if (client.verbose)
        console.log(`size will be ${dataSize}`);
    let data = Buffer.alloc(0);
    let start = 0;
    const remain = dataSize % MAX_CHUNK;
    const packets = Math.floor((dataSize - remain) / MAX_CHUNK);
    if (client.verbose)
        console.log(`rwb: #${packets} packets of max ${MAX_CHUNK} bytes, and extra ${remain} bytes remain`);
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
    if (client.verbose)
        console.log(`_read w/chunk ${start} bytes`);
    return { data, size: start };
}
export async function receiveRawData(size, client) {
    return new Promise((resolve, reject) => {
        if (!client.socket || !(client.socket instanceof net.Socket)) {
            reject(new Error('Socket not available for receiveRawData'));
            return;
        }
        const socket = client.socket;
        let received = Buffer.alloc(0);
        let remaining = size;
        const onData = (data) => {
            received = Buffer.concat([received, data]);
            remaining -= data.length;
            if (client.verbose)
                console.log(`receiveRawData: received ${data.length}, remaining ${remaining}`);
            if (remaining <= 0) {
                socket.removeListener('data', onData);
                socket.removeListener('error', onError);
                resolve(received.subarray(0, size));
            }
        };
        const onError = (err) => {
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
export function getDataSize(client) {
    if (client.lastResponse === CMD_PREPARE_DATA) {
        if (client.lastData.length >= 4) {
            return client.lastData.readUInt32LE(0);
        }
    }
    return 0;
}
export async function receiveChunk(client) {
    // Handle CMD_DATA response
    if (client.lastResponse === CMD_DATA) {
        if (!client.forceUdp && client.socket instanceof net.Socket) {
            if (client.verbose)
                console.log(`_rc_DATA! is ${client.lastData.length} bytes, tcp length is ${client.tcpLength}`);
            if (client.lastData.length < (client.tcpLength - 8)) {
                const need = (client.tcpLength - 8) - client.lastData.length;
                if (client.verbose)
                    console.log(`need more data: ${need}`);
                const moreData = await receiveRawData(need, client);
                return Buffer.concat([client.lastData, moreData]);
            }
            else {
                if (client.verbose)
                    console.log('Enough data');
                return client.lastData;
            }
        }
        else {
            // UDP case
            if (client.verbose)
                console.log(`_rc len is ${client.lastData.length}`);
            return client.lastData;
        }
    }
    // Handle CMD_PREPARE_DATA response
    else if (client.lastResponse === CMD_PREPARE_DATA) {
        const size = getDataSize(client);
        if (client.verbose)
            console.log(`receive chunk: prepare data size is ${size}`);
        if (!client.forceUdp && client.socket instanceof net.Socket) {
            // TCP case
            let dataRecv;
            if (client.lastData.length >= (8 + size)) {
                dataRecv = client.lastData.subarray(8);
            }
            else {
                const additionalData = await receiveRawData(size + 32, client);
                dataRecv = Buffer.concat([client.lastData.subarray(8), additionalData]);
            }
            // For simplicity, assuming data arrives correctly
            // Full implementation would call receiveTcpData here
            // For now, just return the data portion
            return dataRecv.subarray(0, size);
        }
        else {
            // UDP case - receive multiple packets
            const data = [];
            let remaining = size;
            while (true) {
                const dataRecv = await receiveRawData(1024 + 8, client);
                if (dataRecv.length < 8)
                    break;
                const response = dataRecv.readUInt16LE(0);
                if (client.verbose)
                    console.log(`# packet response is: ${response}`);
                if (response === CMD_DATA) {
                    data.push(dataRecv.subarray(8));
                    remaining -= 1024;
                }
                else if (response === CMD_ACK_OK) {
                    break;
                }
                else {
                    if (client.verbose)
                        console.log('broken!');
                    break;
                }
                if (client.verbose)
                    console.log(`still needs ${remaining}`);
                if (remaining <= 0)
                    break;
            }
            return Buffer.concat(data);
        }
    }
    else {
        if (client.verbose)
            console.log(`invalid response ${client.lastResponse}`);
        return Buffer.alloc(0);
    }
}
export async function readChunk(start, size, client) {
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
            if (client.verbose)
                console.log(`ReadChunk: receiveChunk returned empty data on retry ${retries}`);
        }
        catch (e) {
            if (client.verbose)
                console.log(`ReadChunk retry ${retries}:`, e);
        }
    }
    throw new Error(`Can't read chunk ${start}:[${size}]`);
}
export async function freeData(client) {
    await sendCommand(CMD_FREE_DATA, Buffer.alloc(0), 1024, client);
}
//# sourceMappingURL=generalFunctions.js.map