import * as net from 'net';
import * as dgram from 'dgram';
import { Buffer } from 'buffer';
import { CMD_CONNECT, CMD_EXIT, CMD_AUTH, CMD_ACK_OK, CMD_ACK_UNAUTH, CMD_ACK_ERROR, CMD_ACK_UNKNOWN, MACHINE_PREPARE_DATA_1, MACHINE_PREPARE_DATA_2, USHRT_MAX, CMD_PREPARE_DATA, CMD_DATA, CMD_GET_VERSION, CMD_OPTIONS_RRQ, CMD_GET_TIME, CMD_USER_WRQ, CMD_DELETE_USER, CMD_USERTEMP_RRQ, CMD_ATTLOG_RRQ, CMD_RESTART, CMD_UNLOCK, CMD_ENABLEDEVICE, CMD_DISABLEDEVICE, CMD_SET_TIME, CMD_TESTVOICE, CMD_REG_EVENT, EF_ATTLOG, CMD_READ_BUFFER, CMD_PREPARE_BUFFER, CMD_FREE_DATA, CMD_GET_FREE_SIZES, FCT_USER, CMD_ACK_DATA, CMD_DB_RRQ, FCT_FINGERTMP, CMD_DELETE_USERTEMP, _CMD_GET_USERTEMP, _CMD_DEL_USER_TEMP } from './constants.js';
import { createHeader, createTcpTop, makeCommKey, testTcpTop, decodeTime, encodeTime, removeNull } from './utils.js';
export class ZKTeco {
    ip;
    port;
    timeout;
    password;
    forceUdp;
    verbose;
    socket = null;
    isConnected = false;
    sessionId = 0;
    replyId = USHRT_MAX - 1;
    tcpLength = 0;
    lastResponse = 0;
    lastData = Buffer.alloc(0);
    users = 0;
    fingers = 0;
    records = 0;
    usersCapacity = 0;
    fingersCapacity = 0;
    recordsCapacity = 0;
    constructor(ip, port = 4370, timeout = 10000, password = 0, forceUdp = false, verbose = false) {
        this.ip = ip;
        this.port = port;
        this.timeout = timeout;
        this.password = password;
        this.forceUdp = forceUdp;
        this.verbose = verbose;
    }
    async connect() {
        try {
            if (this.isConnected)
                return true;
            await this.createSocket();
            this.sessionId = 0;
            this.replyId = USHRT_MAX - 1;
            const response = await this.sendCommand(CMD_CONNECT, Buffer.alloc(0), 1024);
            if (response && response.length >= 8) {
                this.sessionId = response.readUInt16LE(4);
            }
            const responseCode = response ? response.readUInt16LE(0) : 0;
            if (responseCode === CMD_ACK_UNAUTH) {
                const commKey = makeCommKey(this.password, this.sessionId);
                const authResponse = await this.sendCommand(CMD_AUTH, commKey, 1024);
                if (!authResponse || authResponse.readUInt16LE(0) !== CMD_ACK_OK) {
                    throw new Error('Authentication failed');
                }
            }
            else if (responseCode !== CMD_ACK_OK) {
                throw new Error(`Connection failed with code: ${responseCode}`);
            }
            this.isConnected = true;
            return true;
        }
        catch (err) {
            if (this.verbose)
                console.error('Connection error:', err);
            this.closeSocket();
            return false;
        }
    }
    async disconnect() {
        if (!this.isConnected)
            return true;
        try {
            await this.sendCommand(CMD_EXIT, Buffer.alloc(0), 8);
        }
        catch (e) {
            // Ignore errors on disconnect
        }
        finally {
            this.closeSocket();
            this.isConnected = false;
        }
        return true;
    }
    async createSocket() {
        return new Promise((resolve, reject) => {
            if (!this.forceUdp) {
                const socket = new net.Socket();
                socket.setTimeout(this.timeout);
                socket.connect(this.port, this.ip, () => {
                    this.socket = socket;
                    resolve();
                });
                socket.on('error', (err) => {
                    console.error('Socket error:', err);
                    reject(err);
                });
                socket.on('timeout', () => {
                    socket.destroy();
                    reject(new Error('Connection timed out'));
                });
            }
            else {
                const socket = dgram.createSocket('udp4');
                this.socket = socket;
                resolve(); // UDP is connectionless
            }
        });
    }
    closeSocket() {
        if (this.socket) {
            if (this.socket instanceof net.Socket) {
                this.socket.destroy();
            }
            else {
                this.socket.close();
            }
            this.socket = null;
        }
    }
    async sendCommand(command, commandString, responseSize) {
        if (!this.socket)
            throw new Error('Socket not initialized');
        this.replyId++;
        if (this.replyId >= USHRT_MAX)
            this.replyId = 0;
        const packet = createHeader(command, commandString, this.sessionId, this.replyId);
        if (this.socket instanceof net.Socket) {
            const tcpPacket = createTcpTop(packet);
            return new Promise((resolve, reject) => {
                const socket = this.socket;
                let timeoutId;
                const cleanup = () => {
                    socket.removeListener('data', onData);
                    socket.removeListener('error', onError);
                    socket.removeListener('close', onClose);
                    clearTimeout(timeoutId);
                };
                const onData = (data) => {
                    if (data.length >= 8) {
                        const header1 = data.readUInt16LE(0);
                        const header2 = data.readUInt16LE(2);
                        if (header1 === MACHINE_PREPARE_DATA_1 && header2 === MACHINE_PREPARE_DATA_2) {
                            // Store state for readWithBuffer
                            this.tcpLength = data.readUInt32LE(4);
                            // Extract payload (skip 8 byte TCP header)
                            const payload = data.subarray(8);
                            if (payload.length >= 8) {
                                // Store response code and data
                                this.lastResponse = payload.readUInt16LE(0);
                                this.lastData = payload.subarray(8);
                            }
                            else {
                                this.lastResponse = 0;
                                this.lastData = Buffer.alloc(0);
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
                socket.on('data', onData);
                socket.on('error', onError);
                socket.on('close', onClose);
                socket.write(tcpPacket, (err) => {
                    if (err) {
                        cleanup();
                        reject(err);
                    }
                });
            });
        }
        else {
            return new Promise((resolve, reject) => {
                const socket = this.socket;
                let timeoutId;
                const cleanup = () => {
                    socket.removeListener('message', onMessage);
                    socket.removeListener('error', onError);
                    clearTimeout(timeoutId);
                };
                const onMessage = (msg) => {
                    if (msg.length >= 8) {
                        this.lastResponse = msg.readUInt16LE(0);
                        this.lastData = msg.subarray(8);
                    }
                    else {
                        this.lastResponse = 0;
                        this.lastData = Buffer.alloc(0);
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
                socket.send(packet, this.port, this.ip, (err) => {
                    if (err) {
                        cleanup();
                        reject(err);
                    }
                });
            });
        }
    }
    async getDeviceInfo() {
        return {
            firmwareVersion: await this.getFirmwareVersion(),
            serialNumber: await this.getSerialNumber(),
            platform: await this.getPlatform(),
            deviceName: await this.getDeviceName(),
            macAddress: await this.getMacAddress(),
            deviceTime: await this.getDeviceTime(),
            faceVersion: await this.getFaceVersion(),
            fpVersion: await this.getFpVersion()
        };
    }
    async getFirmwareVersion() {
        const response = await this.sendCommand(CMD_GET_VERSION, Buffer.alloc(0), 1024);
        if (response && response.length > 8) {
            return removeNull(response.subarray(8).toString());
        }
        return '';
    }
    async getSerialNumber() {
        const commandString = Buffer.from('~SerialNumber\x00');
        const response = await this.sendCommand(CMD_OPTIONS_RRQ, commandString, 1024);
        if (response && response.length > 8) {
            const data = response.subarray(8).toString();
            const parts = data.split('=');
            if (parts.length > 1) {
                return removeNull(parts[1] || '');
            }
        }
        return '';
    }
    async getPlatform() {
        const commandString = Buffer.from('~Platform\x00');
        const response = await this.sendCommand(CMD_OPTIONS_RRQ, commandString, 1024);
        if (response && response.length > 8) {
            const data = response.subarray(8).toString();
            const parts = data.split('=');
            if (parts.length > 1) {
                return removeNull(parts[1] || '');
            }
        }
        return '';
    }
    async getDeviceName() {
        const commandString = Buffer.from('~DeviceName\x00');
        const response = await this.sendCommand(CMD_OPTIONS_RRQ, commandString, 1024);
        if (response && response.length > 8) {
            const data = response.subarray(8).toString();
            const parts = data.split('=');
            if (parts.length > 1) {
                return removeNull(parts[1] || '');
            }
        }
        return '';
    }
    async getMacAddress() {
        const commandString = Buffer.from('MAC\x00');
        const response = await this.sendCommand(CMD_OPTIONS_RRQ, commandString, 1024);
        if (response && response.length > 8) {
            const data = response.subarray(8).toString();
            const parts = data.split('=');
            if (parts.length > 1) {
                return removeNull(parts[1] || '');
            }
        }
        return '';
    }
    async getFaceVersion() {
        const commandString = Buffer.from('ZKFaceVersion\x00');
        const response = await this.sendCommand(CMD_OPTIONS_RRQ, commandString, 1024);
        if (response && response.length > 8) {
            const data = response.subarray(8).toString();
            const parts = data.split('=');
            if (parts.length > 1) {
                return parseInt(removeNull(parts[1] || ''), 10) || 0;
            }
        }
        return 0;
    }
    async getFpVersion() {
        const commandString = Buffer.from('~ZKFPVersion\x00');
        const response = await this.sendCommand(CMD_OPTIONS_RRQ, commandString, 1024);
        if (response && response.length > 8) {
            const data = response.subarray(8).toString();
            const parts = data.split('=');
            if (parts.length > 1) {
                return parseInt(removeNull(parts[1] || ''), 10) || 0;
            }
        }
        return 0;
    }
    async getDeviceTime() {
        const response = await this.sendCommand(CMD_GET_TIME, Buffer.alloc(0), 1024);
        if (response && response.length > 8) {
            return decodeTime(response.subarray(8, 12));
        }
        return new Date(0);
    }
    async getUsers() {
        if (this.verbose)
            console.log('Reading users...');
        await this.readSizes();
        if (this.verbose)
            console.log('Sizes read');
        if (this.users === 0) {
            return [];
        }
        if (this.verbose)
            console.log('Reading users...');
        const { data: userdata, size } = await this.readWithBuffer(CMD_USERTEMP_RRQ, FCT_USER);
        if (this.verbose)
            console.log('Users read:', size);
        if (size <= 4) {
            return [];
        }
        // Based on testing, the user data starts at offset 20 (after a 16-byte header + 4-byte size field)
        // This device sends: 4-byte total size + 16-byte header + actual user records
        const headerSkip = 20;
        const remainingSize = userdata.length - headerSkip;
        const userPacketSize = Math.floor(remainingSize / this.users);
        if (this.verbose) {
            console.log('Header skip:', headerSkip, 'packet size:', userPacketSize);
            console.log('Remaining size:', remainingSize, 'users:', this.users);
        }
        if (userPacketSize !== 28 && userPacketSize !== 72) {
            console.warn(`WRN packet size would be ${userPacketSize}`);
        }
        // Skip the header bytes before processing user records
        let userDataBuffer = userdata.subarray(headerSkip);
        const users = [];
        if (this.verbose)
            console.log('User packet size:', userPacketSize);
        if (userPacketSize === 28) {
            // Python: uid, privilege, password, name, card, group_id, timezone, user_id = unpack('<HB5s8sIxBhI',userdata.ljust(28, b'\x00')[:28])
            // Struct: H(2) B(1) 5s(5) 8s(8) I(4) x(1) B(1) h(2) I(4) = 28 bytes
            while (userDataBuffer.length >= 28) {
                const uid = userDataBuffer.readUInt16LE(0); // offset 0-1 (2 bytes)
                const role = userDataBuffer.readUInt8(2); // offset 2 (1 byte)
                const password = removeNull(userDataBuffer.subarray(3, 8).toString()); // offset 3-7 (5 bytes)
                const name = removeNull(userDataBuffer.subarray(8, 16).toString()); // offset 8-15 (8 bytes)
                const card = userDataBuffer.readUInt32LE(16); // offset 16-19 (4 bytes)
                // offset 20 is padding (1 byte) - skip it
                const groupId = userDataBuffer.readUInt8(21); // offset 21 (1 byte)
                // offset 22-23 is timezone (2 bytes) - skip it
                const userIdInt = userDataBuffer.readUInt32LE(24); // offset 24-27 (4 bytes)
                const userId = userIdInt.toString();
                users.push({
                    uid,
                    role,
                    password,
                    name: name || `NN-${userId}`,
                    card,
                    userId
                });
                userDataBuffer = userDataBuffer.subarray(28);
            }
        }
        else {
            // Python: uid, privilege, password, name, card, group_id, user_id = unpack('<HB8s24sIx7sx24s', userdata.ljust(72, b'\x00')[:72])
            // Struct: H(2) B(1) 8s(8) 24s(24) I(4) x(1) 7s(7) x(1) 24s(24) = 72 bytes
            while (userDataBuffer.length >= 72) {
                const uid = userDataBuffer.readUInt16LE(0); // offset 0-1 (2 bytes)
                const role = userDataBuffer.readUInt8(2); // offset 2 (1 byte)
                const password = removeNull(userDataBuffer.subarray(3, 11).toString()); // offset 3-10 (8 bytes)
                const name = removeNull(userDataBuffer.subarray(11, 35).toString()); // offset 11-34 (24 bytes)
                const card = userDataBuffer.readUInt32LE(35); // offset 35-38 (4 bytes)
                // offset 39 is padding (1 byte) - skip it
                const groupId = removeNull(userDataBuffer.subarray(40, 47).toString()); // offset 40-46 (7 bytes)
                // offset 47 is padding (1 byte) - skip it
                const userId = removeNull(userDataBuffer.subarray(48, 72).toString()); // offset 48-71 (24 bytes)
                users.push({
                    uid,
                    role,
                    password,
                    name: name || `NN-${userId}`,
                    card,
                    userId
                });
                userDataBuffer = userDataBuffer.subarray(72);
            }
        }
        return users;
    }
    async getMemoryInfo() {
        const response = await this.sendCommand(CMD_GET_FREE_SIZES, Buffer.alloc(0), 1024);
        if (!response || response.length < 8)
            return null;
        const responseCode = response.readUInt16LE(0);
        if (responseCode !== CMD_ACK_OK && responseCode !== CMD_ACK_DATA && responseCode !== CMD_PREPARE_DATA) {
            return null;
        }
        const data = response.subarray(8);
        if (data.length < 80)
            return null;
        const usedUsers = data.readInt32LE(16); // fields[4] * 4 = 16
        const usedFingers = data.readInt32LE(24); // fields[6] * 4 = 24
        const usedRecords = data.readInt32LE(32); // fields[8] * 4 = 32
        const totalFingers = data.readInt32LE(56); // fields[14] * 4 = 56
        const totalUsers = data.readInt32LE(60); // fields[15] * 4 = 60
        const totalRecords = data.readInt32LE(64); // fields[16] * 4 = 64
        return {
            usedUsers,
            totalUsers,
            usedFingers,
            totalFingers,
            usedRecords,
            totalRecords
        };
    }
    async readSizes() {
        if (this.verbose)
            console.log('Reading sizes...');
        const memInfo = await this.getMemoryInfo();
        if (memInfo) {
            if (this.verbose)
                console.log('Sizes read:', memInfo);
            this.users = memInfo.usedUsers;
            this.fingers = memInfo.usedFingers;
            this.records = memInfo.usedRecords;
            this.usersCapacity = memInfo.totalUsers;
            this.fingersCapacity = memInfo.totalFingers;
            this.recordsCapacity = memInfo.totalRecords;
        }
    }
    async receiveRawData(size) {
        return new Promise((resolve, reject) => {
            if (!this.socket || !(this.socket instanceof net.Socket)) {
                reject(new Error('Socket not available for receiveRawData'));
                return;
            }
            const socket = this.socket;
            let received = Buffer.alloc(0);
            let remaining = size;
            const onData = (data) => {
                received = Buffer.concat([received, data]);
                remaining -= data.length;
                if (this.verbose)
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
    getDataSize() {
        if (this.lastResponse === CMD_PREPARE_DATA) {
            if (this.lastData.length >= 4) {
                return this.lastData.readUInt32LE(0);
            }
        }
        return 0;
    }
    async receiveChunk() {
        // Handle CMD_DATA response
        if (this.lastResponse === CMD_DATA) {
            if (!this.forceUdp && this.socket instanceof net.Socket) {
                if (this.verbose)
                    console.log(`_rc_DATA! is ${this.lastData.length} bytes, tcp length is ${this.tcpLength}`);
                if (this.lastData.length < (this.tcpLength - 8)) {
                    const need = (this.tcpLength - 8) - this.lastData.length;
                    if (this.verbose)
                        console.log(`need more data: ${need}`);
                    const moreData = await this.receiveRawData(need);
                    return Buffer.concat([this.lastData, moreData]);
                }
                else {
                    if (this.verbose)
                        console.log('Enough data');
                    return this.lastData;
                }
            }
            else {
                // UDP case
                if (this.verbose)
                    console.log(`_rc len is ${this.lastData.length}`);
                return this.lastData;
            }
        }
        // Handle CMD_PREPARE_DATA response
        else if (this.lastResponse === CMD_PREPARE_DATA) {
            const size = this.getDataSize();
            if (this.verbose)
                console.log(`receive chunk: prepare data size is ${size}`);
            if (!this.forceUdp && this.socket instanceof net.Socket) {
                // TCP case
                let dataRecv;
                if (this.lastData.length >= (8 + size)) {
                    dataRecv = this.lastData.subarray(8);
                }
                else {
                    const additionalData = await this.receiveRawData(size + 32);
                    dataRecv = Buffer.concat([this.lastData.subarray(8), additionalData]);
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
                    const dataRecv = await this.receiveRawData(1024 + 8);
                    if (dataRecv.length < 8)
                        break;
                    const response = dataRecv.readUInt16LE(0);
                    if (this.verbose)
                        console.log(`# packet response is: ${response}`);
                    if (response === CMD_DATA) {
                        data.push(dataRecv.subarray(8));
                        remaining -= 1024;
                    }
                    else if (response === CMD_ACK_OK) {
                        break;
                    }
                    else {
                        if (this.verbose)
                            console.log('broken!');
                        break;
                    }
                    if (this.verbose)
                        console.log(`still needs ${remaining}`);
                    if (remaining <= 0)
                        break;
                }
                return Buffer.concat(data);
            }
        }
        else {
            if (this.verbose)
                console.log(`invalid response ${this.lastResponse}`);
            return Buffer.alloc(0);
        }
    }
    async readChunk(start, size) {
        for (let retries = 0; retries < 3; retries++) {
            try {
                const commandString = Buffer.alloc(8);
                commandString.writeInt32LE(start, 0);
                commandString.writeInt32LE(size, 4);
                const responseSize = (!this.forceUdp && this.socket instanceof net.Socket) ? size + 32 : 1024 + 8;
                await this.sendCommand(CMD_READ_BUFFER, commandString, responseSize);
                // Call receiveChunk to process the response
                const data = await this.receiveChunk();
                if (data.length > 0) {
                    return data;
                }
                if (this.verbose)
                    console.log(`ReadChunk: receiveChunk returned empty data on retry ${retries}`);
            }
            catch (e) {
                if (this.verbose)
                    console.log(`ReadChunk retry ${retries}:`, e);
            }
        }
        throw new Error(`Can't read chunk ${start}:[${size}]`);
    }
    async readWithBuffer(command, fct = 0, ext = 0) {
        const commandString = Buffer.alloc(11);
        commandString.writeUInt8(1, 0);
        commandString.writeUInt16LE(command, 1);
        commandString.writeUInt32LE(fct, 3);
        commandString.writeUInt32LE(ext, 7);
        const response = await this.sendCommand(CMD_PREPARE_BUFFER, commandString, 1024);
        if (!response) {
            throw new Error('RWB Not supported');
        }
        const MAX_CHUNK = (!this.forceUdp && this.socket instanceof net.Socket) ? 0xFFc0 : 16 * 1024;
        // Handle CMD_DATA response directly (e.g. small data)
        if (this.lastResponse === CMD_DATA) {
            if (this.socket instanceof net.Socket && !this.forceUdp) {
                // TCP: Check if we have all data based on TCP length
                if (this.verbose)
                    console.log(`DATA! is ${this.lastData.length} bytes, tcp length is ${this.tcpLength}`);
                if (this.lastData.length < (this.tcpLength - 8)) {
                    const need = (this.tcpLength - 8) - this.lastData.length;
                    if (this.verbose)
                        console.log(`need more data: ${need}`);
                    const moreData = await this.receiveRawData(need);
                    const fullData = Buffer.concat([this.lastData, moreData]);
                    return { data: fullData, size: fullData.length };
                }
                else {
                    if (this.verbose)
                        console.log('Enough data');
                    return { data: this.lastData, size: this.lastData.length };
                }
            }
            else {
                // UDP
                return { data: this.lastData, size: this.lastData.length };
            }
        }
        // Handle CMD_PREPARE_DATA response (large data, need to read chunks)
        // Python uses offset 1: size = unpack('I', self.__data[1:5])[0]
        // The first byte is a flag/command byte
        if (this.lastData.length < 5) {
            throw new Error('Invalid PREPARE_DATA response: too small');
        }
        const dataSize = this.lastData.readUInt32LE(1); // Python uses offset 1!
        if (this.verbose)
            console.log(`size will be ${dataSize}`);
        let data = Buffer.alloc(0);
        let start = 0;
        const remain = dataSize % MAX_CHUNK;
        const packets = Math.floor((dataSize - remain) / MAX_CHUNK);
        if (this.verbose)
            console.log(`rwb: #${packets} packets of max ${MAX_CHUNK} bytes, and extra ${remain} bytes remain`);
        for (let i = 0; i < packets; i++) {
            const chunk = await this.readChunk(start, MAX_CHUNK);
            data = Buffer.concat([data, chunk]);
            start += MAX_CHUNK;
        }
        if (remain > 0) {
            const chunk = await this.readChunk(start, remain);
            data = Buffer.concat([data, chunk]);
            start += remain;
        }
        await this.freeData();
        if (this.verbose)
            console.log(`_read w/chunk ${start} bytes`);
        return { data, size: start };
    }
    async freeData() {
        await this.sendCommand(CMD_FREE_DATA, Buffer.alloc(0), 1024);
    }
    async setUser(uid, name, password, role = 0, card = 0) {
        const commandString = Buffer.alloc(72); // ZK8 size
        commandString.writeUInt16LE(uid, 0);
        commandString.writeUInt8(role, 2);
        commandString.write(password, 3, 8);
        commandString.write(name, 11, 24);
        commandString.writeUInt32LE(card, 35);
        commandString.writeUInt8(1, 40); // Group
        // ... other fields zeroed out
        const response = await this.sendCommand(CMD_USER_WRQ, commandString, 1024);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }
    async deleteUser(uid) {
        const commandString = Buffer.alloc(2);
        commandString.writeUInt16LE(uid, 0);
        const response = await this.sendCommand(CMD_DELETE_USER, commandString, 1024);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }
    async getAttendance() {
        if (this.verbose)
            console.log('Reading attendance records...');
        // Read sizes to get number of records
        await this.readSizes();
        if (this.verbose)
            console.log('Records count:', this.records);
        if (this.records === 0) {
            return [];
        }
        // Get users to map UIDs to user IDs
        const users = await this.getUsers();
        if (this.verbose)
            console.log('Users loaded for attendance mapping:', users.length);
        // Read attendance data with buffer
        const { data: attendanceData, size } = await this.readWithBuffer(CMD_ATTLOG_RRQ);
        if (this.verbose)
            console.log('Attendance data size:', size, 'bytes');
        if (size < 4) {
            if (this.verbose)
                console.warn('WRN: no attendance data');
            return [];
        }
        // Similar to user data, attendance data likely has the same 20-byte header
        // (4 bytes size + 16 bytes of device-specific header)
        let headerSkip = 20;
        let remainingSize = attendanceData.length - headerSkip;
        let recordSize = Math.floor(remainingSize / this.records);
        if (this.verbose) {
            console.log('Initial (20-byte skip) - remainingSize:', remainingSize, 'recordSize:', recordSize);
        }
        // If we're within 1 byte of a valid record size, accept it (due to rounding)
        const isCloseToValid = (size) => {
            return (Math.abs(size - 8) <= 1) || (Math.abs(size - 16) <= 1) || (Math.abs(size - 40) <= 1);
        };
        // If close to valid, round to the nearest valid size
        if (isCloseToValid(recordSize)) {
            if (Math.abs(recordSize - 8) <= 1)
                recordSize = 8;
            else if (Math.abs(recordSize - 16) <= 1)
                recordSize = 16;
            else if (Math.abs(recordSize - 40) <= 1)
                recordSize = 40;
            if (this.verbose) {
                console.log(`Rounded to valid record size: ${recordSize}`);
            }
        }
        else {
            // Try to auto-detect the correct offset
            // Try different header sizes from 4 to 30 bytes
            for (let testSkip = 4; testSkip <= 30; testSkip++) {
                remainingSize = attendanceData.length - testSkip;
                const testRecordSize = Math.floor(remainingSize / this.records);
                if (testRecordSize === 8 || testRecordSize === 16 || testRecordSize === 40) {
                    recordSize = testRecordSize;
                    headerSkip = testSkip;
                    if (this.verbose) {
                        console.log(`Found valid record size ${recordSize} with ${testSkip}-byte header skip`);
                    }
                    break;
                }
            }
        }
        if (this.verbose) {
            console.log('Final - Header skip:', headerSkip, 'record size:', recordSize);
        }
        if (recordSize !== 8 && recordSize !== 16 && recordSize !== 40) {
            console.warn(`WRN: Unexpected record size ${recordSize}`);
        }
        // Skip the header bytes before processing attendance records
        let dataBuffer = attendanceData.subarray(headerSkip);
        const attendances = [];
        if (recordSize === 8) {
            // 8-byte record format: uid(2), status(1), timestamp(4), punch(1)
            while (dataBuffer.length >= 8) {
                const uid = dataBuffer.readUInt16LE(0);
                const status = dataBuffer.readUInt8(2);
                const timestampBytes = dataBuffer.subarray(3, 7);
                const timestamp = decodeTime(timestampBytes);
                const punch = dataBuffer.readUInt8(7);
                // Find user_id from uid
                let userId = uid.toString();
                const user = users.find(u => u.uid === uid);
                if (user) {
                    userId = user.userId;
                }
                attendances.push({
                    userId,
                    timestamp,
                    status,
                    punch,
                    uid
                });
                dataBuffer = dataBuffer.subarray(8);
            }
        }
        else if (recordSize === 16) {
            // 16-byte record format: user_id(4), timestamp(4), status(1), punch(1), reserved(2), workcode(4)
            while (dataBuffer.length >= 16) {
                const userIdInt = dataBuffer.readUInt32LE(0);
                const userId = userIdInt.toString();
                const timestampBytes = dataBuffer.subarray(4, 8);
                const timestamp = decodeTime(timestampBytes);
                const status = dataBuffer.readUInt8(8);
                const punch = dataBuffer.readUInt8(9);
                // Skip reserved(2) and workcode(4)
                // Find uid from user_id
                let uid = userIdInt;
                const user = users.find(u => u.userId === userId);
                if (user) {
                    uid = user.uid;
                }
                attendances.push({
                    userId,
                    timestamp,
                    status,
                    punch,
                    uid
                });
                dataBuffer = dataBuffer.subarray(16);
            }
        }
        else {
            // 40-byte record format (default): uid(2), user_id(24), status(1), timestamp(4), punch(1), space(8)
            while (dataBuffer.length >= 40) {
                // Python checks for special code_init pattern: b'\xff255\x00\x00\x00\x00\x00'
                // This seems to be a marker that some devices send before attendance records
                const codeInit = Buffer.from([0xff, 0x32, 0x35, 0x35, 0x00, 0x00, 0x00, 0x00, 0x00]);
                if (dataBuffer.length >= codeInit.length) {
                    let hasCodeInit = true;
                    for (let i = 0; i < codeInit.length; i++) {
                        if (dataBuffer[i] !== codeInit[i]) {
                            hasCodeInit = false;
                            break;
                        }
                    }
                    if (hasCodeInit) {
                        // Skip the code_init bytes
                        dataBuffer = dataBuffer.subarray(codeInit.length);
                    }
                }
                if (dataBuffer.length < 40)
                    break;
                const uid = dataBuffer.readUInt16LE(0);
                const userId = removeNull(dataBuffer.subarray(2, 26).toString());
                const status = dataBuffer.readUInt8(26);
                const timestampBytes = dataBuffer.subarray(27, 31);
                const timestamp = decodeTime(timestampBytes);
                const punch = dataBuffer.readUInt8(31);
                // Skip space (8 bytes)
                attendances.push({
                    userId: userId || uid.toString(),
                    timestamp,
                    status,
                    punch,
                    uid
                });
                dataBuffer = dataBuffer.subarray(recordSize); // Use recordSize to handle variations
            }
        }
        if (this.verbose)
            console.log('Parsed', attendances.length, 'attendance records');
        return attendances;
    }
    async restart() {
        const response = await this.sendCommand(CMD_RESTART, Buffer.alloc(0), 1024);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }
    async unlock(time = 3) {
        const commandString = Buffer.alloc(4);
        commandString.writeUInt32LE(time * 10, 0); // Delay in tenths of seconds? Python says int(time)*10
        const response = await this.sendCommand(CMD_UNLOCK, commandString, 1024);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }
    async enableDevice() {
        const response = await this.sendCommand(CMD_ENABLEDEVICE, Buffer.alloc(0), 1024);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }
    async disableDevice() {
        const response = await this.sendCommand(CMD_DISABLEDEVICE, Buffer.alloc(0), 1024);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }
    async setTime(date) {
        const time = encodeTime(date);
        const commandString = Buffer.alloc(4);
        commandString.writeUInt32LE(time, 0);
        const response = await this.sendCommand(CMD_SET_TIME, commandString, 1024);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }
    async testVoice(index = 0) {
        const commandString = Buffer.alloc(4);
        commandString.writeUInt32LE(index, 0);
        const response = await this.sendCommand(CMD_TESTVOICE, commandString, 1024);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }
    // Live capture would require event emitter or callback mechanism
    // For now, just a placeholder or basic implementation if requested
    async startLiveCapture() {
        // TODO: Implement live capture loop
    }
    /**
     * Get all fingerprint templates from the device
     * @returns Array of ZKTecoFinger objects
     */
    async getTemplates() {
        if (this.verbose)
            console.log('Reading fingerprint templates...');
        await this.readSizes();
        if (this.fingers === 0) {
            return [];
        }
        const { data: templateData, size } = await this.readWithBuffer(CMD_DB_RRQ, FCT_FINGERTMP);
        if (this.verbose)
            console.log('Template data size:', size, 'bytes');
        if (size < 4) {
            if (this.verbose)
                console.warn('WRN: no template data');
            return [];
        }
        const templates = [];
        // Similar to user/attendance data, use 20-byte header skip
        let headerSkip = 20;
        let dataBuffer = templateData.subarray(headerSkip);
        // First try with 20-byte offset, if that doesn't work, try 4-byte
        if (dataBuffer.length < 6) {
            headerSkip = 4;
            dataBuffer = templateData.subarray(headerSkip);
        }
        // Read total size from first 4 bytes (after header skip adjustment)
        let totalSize = templateData.readUInt32LE(headerSkip - 4 >= 0 ? headerSkip - 4 : 0);
        // If totalSize doesn't seem right, use remaining data length
        if (totalSize <= 0 || totalSize > dataBuffer.length) {
            totalSize = dataBuffer.length;
        }
        if (this.verbose) {
            console.log('Template total size:', totalSize);
            console.log('Header skip:', headerSkip);
        }
        // Parse templates - each template has variable size
        while (dataBuffer.length >= 6 && totalSize > 0) {
            // Template header: size(2), uid(2), fid(1), valid(1)
            const templateSize = dataBuffer.readUInt16LE(0);
            const uid = dataBuffer.readUInt16LE(2);
            const fid = dataBuffer.readUInt8(4);
            const valid = dataBuffer.readUInt8(5);
            if (templateSize < 6 || templateSize > dataBuffer.length) {
                if (this.verbose)
                    console.log('Invalid template size:', templateSize);
                break;
            }
            // Extract template data (size - 6 bytes for header)
            const templateBytes = dataBuffer.subarray(6, templateSize);
            const template = templateBytes.toString('base64'); // Store as base64
            templates.push({
                uid,
                finger: fid,
                valid,
                template
            });
            if (this.verbose) {
                console.log(`Template: uid=${uid}, finger=${fid}, valid=${valid}, size=${templateSize}`);
            }
            // Move to next template
            dataBuffer = dataBuffer.subarray(templateSize);
            totalSize -= templateSize;
        }
        if (this.verbose)
            console.log('Parsed', templates.length, 'fingerprint templates');
        return templates;
    }
    /**
     * Get a specific user's fingerprint template
     * @param uid - User's UID (device-generated ID)
     * @param tempId - Finger index (0-9)
     * @param userId - Optional user ID string (will lookup UID if provided without uid)
     * @returns ZKTecoFinger object or null if not found
     */
    async getUserTemplate(uid = 0, tempId = 0, userId = '') {
        if (this.verbose)
            console.log(`Getting template for uid=${uid}, tempId=${tempId}, userId=${userId}`);
        // If uid is not provided, lookup by userId
        if (!uid && userId) {
            const users = await this.getUsers();
            const user = users.find(u => u.userId === userId);
            if (!user) {
                if (this.verbose)
                    console.log('User not found:', userId);
                return null;
            }
            uid = user.uid;
        }
        if (!uid) {
            if (this.verbose)
                console.log('No UID provided');
            return null;
        }
        // Try up to 3 times
        for (let retry = 0; retry < 3; retry++) {
            try {
                // Pack command: uid (2 bytes) + temp_id (1 byte)
                const commandString = Buffer.alloc(3);
                commandString.writeInt16LE(uid, 0);
                commandString.writeInt8(tempId, 2);
                const response = await this.sendCommand(_CMD_GET_USERTEMP, commandString, 1024 + 8);
                if (!response) {
                    if (this.verbose)
                        console.log('No response, retry', retry + 1);
                    continue;
                }
                // Receive the chunk data
                const data = await this.receiveChunk();
                if (data && data.length > 0) {
                    // Remove last byte and check for padding
                    let templateData = data.subarray(0, data.length - 1);
                    // Check for 6-byte null padding at the end
                    if (templateData.length >= 6) {
                        const last6 = templateData.subarray(templateData.length - 6);
                        if (last6.every(b => b === 0)) {
                            templateData = templateData.subarray(0, templateData.length - 6);
                        }
                    }
                    return {
                        uid,
                        finger: tempId,
                        valid: 1,
                        template: templateData.toString('base64')
                    };
                }
                if (this.verbose)
                    console.log('Retry get_user_template', retry + 1);
            }
            catch (e) {
                if (this.verbose)
                    console.log('Error getting template:', e);
            }
        }
        if (this.verbose)
            console.log("Can't read/find finger");
        return null;
    }
    /**
     * Delete a specific user's fingerprint template
     * @param uid - User's UID (device-generated ID)
     * @param tempId - Finger index (0-9)
     * @param userId - Optional user ID string (will lookup UID if provided without uid)
     * @returns true if deleted successfully, false otherwise
     */
    async deleteUserTemplate(uid = 0, tempId = 0, userId = '') {
        if (this.verbose)
            console.log(`Deleting template for uid=${uid}, tempId=${tempId}, userId=${userId}`);
        // TCP mode with userId - use the special command
        if (this.socket instanceof net.Socket && userId) {
            // Pack command: user_id (24 bytes) + temp_id (1 byte)
            const commandString = Buffer.alloc(25);
            commandString.write(userId, 0, 24, 'utf8');
            commandString.writeUInt8(tempId, 24);
            const response = await this.sendCommand(_CMD_DEL_USER_TEMP, commandString, 1024);
            if (response && response.length >= 2) {
                const responseCode = response.readUInt16LE(0);
                return responseCode === CMD_ACK_OK;
            }
            return false;
        }
        // If uid is not provided, lookup by userId
        if (!uid && userId) {
            const users = await this.getUsers();
            const user = users.find(u => u.userId === userId);
            if (!user) {
                if (this.verbose)
                    console.log('User not found:', userId);
                return false;
            }
            uid = user.uid;
        }
        if (!uid) {
            if (this.verbose)
                console.log('No UID provided');
            return false;
        }
        // Pack command: uid (2 bytes) + temp_id (1 byte)
        const commandString = Buffer.alloc(3);
        commandString.writeInt16LE(uid, 0);
        commandString.writeInt8(tempId, 2);
        const response = await this.sendCommand(CMD_DELETE_USERTEMP, commandString, 1024);
        if (response && response.length >= 2) {
            const responseCode = response.readUInt16LE(0);
            return responseCode === CMD_ACK_OK;
        }
        return false;
    }
}
//# sourceMappingURL=zkteco.js.map