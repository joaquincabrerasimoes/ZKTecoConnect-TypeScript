import * as net from 'net';
import * as dgram from 'dgram';
import { Buffer } from 'buffer';
import { createSocket, closeSocket, sendCommand, readSizes, readWithBuffer, receiveChunk } from '../utils/generalFunctions.js';
import type { ZKTecoAttendance, ZKTecoDeviceInfo, ZKTecoFinger } from '../others/interfaces.js';
import { makeCommKey, removeNull, decodeTime, encodeTime } from '../utils/utils.js';
import { ZKTecoUser } from './zkTecoUser.js';

import {
    CMD_DELETE_USERTEMP, CMD_TESTVOICE, USHRT_MAX, _CMD_DEL_USER_TEMP, _CMD_GET_USERTEMP,
    CMD_CONNECT, CMD_AUTH, CMD_ACK_OK, CMD_ACK_UNAUTH, CMD_OPTIONS_RRQ, CMD_GET_VERSION,
    CMD_GET_TIME, CMD_EXIT, CMD_GET_FREE_SIZES, CMD_ACK_DATA, CMD_PREPARE_DATA, CMD_USERTEMP_RRQ,
    FCT_USER, CMD_ENABLEDEVICE, CMD_DISABLEDEVICE, CMD_SET_TIME, CMD_ATTLOG_RRQ, CMD_DB_RRQ,
    FCT_FINGERTMP, CMD_RESTART, CMD_UNLOCK, CMD_USER_WRQ, CMD_DELETE_USER, CMD_REFRESHDATA,
    USER_DEFAULT, USER_ADMIN
} from '../others/constants.js';

class ZKTecoClient {
    ip: string;
    port: number;
    timeout: number;
    password: number;
    forceUdp: boolean;
    verbose: boolean;

    socket: net.Socket | dgram.Socket | null = null;
    isConnected: boolean = false;
    sessionId: number = 0;
    replyId: number = USHRT_MAX - 1;
    tcpLength: number = 0;
    lastResponse: number = 0;
    lastData: Buffer = Buffer.alloc(0);

    nextUid_: number = 1;
    nextUserId_: string = '1';
    userPacketSize_: number = 72;

    users: number = 0;
    fingers: number = 0;
    records: number = 0;
    usersCapacity: number = 0;
    fingersCapacity: number = 0;
    recordsCapacity: number = 0;

    constructor(ip: string, port: number, timeout: number, password: number, forceUdp: boolean | null, verbose: boolean | null) {
        this.ip = ip;
        this.port = port;
        this.timeout = timeout;
        this.password = password;
        this.forceUdp = forceUdp ?? false;
        this.verbose = verbose ?? false;
    }

    public async connect(): Promise<boolean> {
        try {
            if (this.isConnected) return true;

            this.socket = await createSocket(this.ip, this.port, this.timeout, this.forceUdp, this);

            this.sessionId = 0;
            this.replyId = USHRT_MAX - 1;

            const response = await sendCommand(CMD_CONNECT, Buffer.alloc(0), 1024, this);

            if (response && response.length >= 8) {
                this.sessionId = response.readUInt16LE(4);
            }

            const responseCode = response ? response.readUInt16LE(0) : 0;

            if (responseCode === CMD_ACK_UNAUTH) {
                const commKey = makeCommKey(this.password, this.sessionId);
                const authResponse = await sendCommand(CMD_AUTH, commKey, 1024, this);

                if (!authResponse || authResponse.readUInt16LE(0) !== CMD_ACK_OK) {
                    throw new Error('Authentication failed');
                }
            } else if (responseCode !== CMD_ACK_OK) {
                throw new Error(`Connection failed with code: ${responseCode}`);
            }

            this.nextUid_ = await this.getMaxUid() + 2;

            this.isConnected = true;
            return true;
        } catch (err) {
            if (this.verbose) console.error('Connection error:', err);
            closeSocket(this);
            this.socket = null;
            return false;
        }
    }

    public async disconnect(): Promise<boolean> {
        if (!this.isConnected) return true;
        try {
            await sendCommand(CMD_EXIT, Buffer.alloc(0), 8, this);
        } catch (e) {
            // Ignore errors on disconnect
        } finally {
            closeSocket(this);
            this.socket = null;
            this.isConnected = false;
        }
        return true;
    }

    public async getDeviceInfo(): Promise<ZKTecoDeviceInfo> {
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

    public async getFirmwareVersion(): Promise<string> {
        const response = await sendCommand(CMD_GET_VERSION, Buffer.alloc(0), 1024, this);
        if (response && response.length > 8) {
            return removeNull(response.subarray(8).toString());
        }
        return '';
    }

    public async getSerialNumber(): Promise<string> {
        const commandString = Buffer.from('~SerialNumber\x00');
        const response = await sendCommand(CMD_OPTIONS_RRQ, commandString, 1024, this);
        if (response && response.length > 8) {
            const data = response.subarray(8).toString();
            const parts = data.split('=');
            if (parts.length > 1) {
                return removeNull(parts[1] || '');
            }
        }
        return '';
    }

    public async getPlatform(): Promise<string> {
        const commandString = Buffer.from('~Platform\x00');
        const response = await sendCommand(CMD_OPTIONS_RRQ, commandString, 1024, this);
        if (response && response.length > 8) {
            const data = response.subarray(8).toString();
            const parts = data.split('=');
            if (parts.length > 1) {
                return removeNull(parts[1] || '');
            }
        }
        return '';
    }

    public async getDeviceName(): Promise<string> {
        const commandString = Buffer.from('~DeviceName\x00');
        const response = await sendCommand(CMD_OPTIONS_RRQ, commandString, 1024, this);
        if (response && response.length > 8) {
            const data = response.subarray(8).toString();
            const parts = data.split('=');
            if (parts.length > 1) {
                return removeNull(parts[1] || '');
            }
        }
        return '';
    }

    public async getMacAddress(): Promise<string> {
        const commandString = Buffer.from('MAC\x00');
        const response = await sendCommand(CMD_OPTIONS_RRQ, commandString, 1024, this);
        if (response && response.length > 8) {
            const data = response.subarray(8).toString();
            const parts = data.split('=');
            if (parts.length > 1) {
                return removeNull(parts[1] || '');
            }
        }
        return '';
    }

    public async getFaceVersion(): Promise<number> {
        const commandString = Buffer.from('ZKFaceVersion\x00');
        const response = await sendCommand(CMD_OPTIONS_RRQ, commandString, 1024, this);
        if (response && response.length > 8) {
            const data = response.subarray(8).toString();
            const parts = data.split('=');
            if (parts.length > 1) {
                return parseInt(removeNull(parts[1] || ''), 10) || 0;
            }
        }
        return 0;
    }

    public async getFpVersion(): Promise<number> {
        const commandString = Buffer.from('~ZKFPVersion\x00');
        const response = await sendCommand(CMD_OPTIONS_RRQ, commandString, 1024, this);
        if (response && response.length > 8) {
            const data = response.subarray(8).toString();
            const parts = data.split('=');
            if (parts.length > 1) {
                return parseInt(removeNull(parts[1] || ''), 10) || 0;
            }
        }
        return 0;
    }

    public async getDeviceTime(): Promise<Date> {
        const response = await sendCommand(CMD_GET_TIME, Buffer.alloc(0), 1024, this);
        if (response && response.length > 8) {
            return decodeTime(response.subarray(8, 12));
        }
        return new Date(0);
    }

    public async getMemoryInfo(): Promise<{
        usedUsers: number;
        totalUsers: number;
        usedFingers: number;
        totalFingers: number;
        usedRecords: number;
        totalRecords: number;
    } | null> {
        const response = await sendCommand(CMD_GET_FREE_SIZES, Buffer.alloc(0), 1024, this);

        if (!response || response.length < 8) return null;

        const responseCode = response.readUInt16LE(0);
        if (responseCode !== CMD_ACK_OK && responseCode !== CMD_ACK_DATA && responseCode !== CMD_PREPARE_DATA) {
            return null;
        }

        const data = response.subarray(8);
        if (data.length < 80) return null;

        const usedUsers = data.readInt32LE(16);      // fields[4] * 4 = 16
        const usedFingers = data.readInt32LE(24);    // fields[6] * 4 = 24
        const usedRecords = data.readInt32LE(32);    // fields[8] * 4 = 32
        const totalFingers = data.readInt32LE(56);   // fields[14] * 4 = 56
        const totalUsers = data.readInt32LE(60);     // fields[15] * 4 = 60
        const totalRecords = data.readInt32LE(64);   // fields[16] * 4 = 64

        return {
            usedUsers,
            totalUsers,
            usedFingers,
            totalFingers,
            usedRecords,
            totalRecords
        };
    }

    public async getUsers(): Promise<ZKTecoUser[]> {
        if (this.verbose) console.log('Reading users...');
        await readSizes(this);

        if (this.verbose) console.log('Sizes read');

        if (this.users === 0) {
            return [];
        }

        if (this.verbose) console.log('Reading users...');
        const { data: userdata, size } = await readWithBuffer(CMD_USERTEMP_RRQ, FCT_USER, undefined, this);

        if (this.verbose) {
            console.log('Users read:', size);
            console.log('User buffer length:', userdata.length);
        }
        if (size <= 4) {
            return [];
        }

        if (this.verbose) {
            console.log('Userdata head (32 bytes):', userdata.subarray(0, 32));
        }

        const sizeOffsetsToCheck = [0, 4, 8, 12, 16, 20];
        let sizeFieldOffset = -1;
        let totalSize = 0;

        for (const offset of sizeOffsetsToCheck) {
            if (userdata.length < offset + 4 || this.users === 0) continue;
            const candidateSize = userdata.readUInt32LE(offset);
            if (candidateSize <= 0) continue;
            const packetSizeCandidate = candidateSize / this.users;
            if (packetSizeCandidate === 28 || packetSizeCandidate === 72) {
                sizeFieldOffset = offset;
                totalSize = candidateSize;
                break;
            }
        }

        if (sizeFieldOffset === -1 && userdata.length >= 4) {
            sizeFieldOffset = 0;
            totalSize = userdata.readUInt32LE(0);
        }

        if (this.verbose) {
            console.log('Detected size field offset:', sizeFieldOffset);
        }

        let payloadBuffer = userdata;
        if (sizeFieldOffset > 0 && sizeFieldOffset < userdata.length) {
            payloadBuffer = Buffer.concat([
                userdata.subarray(sizeFieldOffset),
                userdata.subarray(0, sizeFieldOffset)
            ]);
        }

        if (payloadBuffer.length < 4) {
            return [];
        }

        // Re-read total size after potential rotation
        totalSize = payloadBuffer.readUInt32LE(0);

        if (this.users > 0) {
            this.userPacketSize_ = Math.floor(totalSize / this.users);
        }

        if (this.userPacketSize_ !== 28 && this.userPacketSize_ !== 72) {
            if (this.verbose) console.warn(`WRN packet size would be ${this.userPacketSize_}`);
        }

        if (this.verbose) {
            console.log('Total user payload size:', totalSize);
            console.log('Computed packet size:', this.userPacketSize_, 'users:', this.users);
        }

        let userDataBuffer = payloadBuffer.subarray(4, 4 + totalSize);
        if (userDataBuffer.length < totalSize && this.verbose) {
            console.warn(`User data buffer shorter (${userDataBuffer.length}) than expected (${totalSize})`);
        }

        const parseUsersFromBuffer = (buffer: Buffer): ZKTecoUser[] => {
            const parsedUsers: ZKTecoUser[] = [];
            let slice = buffer;

            if (this.userPacketSize_ === 28) {
                while (slice.length >= 28) {
                    const uid = slice.readUInt16LE(0);
                    const role = slice.readUInt8(2);
                    const password = removeNull(slice.subarray(3, 8).toString());
                    const name = removeNull(slice.subarray(8, 16).toString());
                    const card = slice.readUInt32LE(16);
                    const userIdInt = slice.readUInt32LE(24);
                    const userId = userIdInt.toString();

                    parsedUsers.push(new ZKTecoUser(
                        uid,
                        role,
                        password,
                        name || `NN-${userId}`,
                        card,
                        userId,
                        this
                    ));

                    slice = slice.subarray(28);
                }
            } else {
                while (slice.length >= 72) {
                    const uid = slice.readUInt16LE(0);
                    const role = slice.readUInt8(2);
                    const password = removeNull(slice.subarray(3, 11).toString());
                    const name = removeNull(slice.subarray(11, 35).toString());
                    const card = slice.readUInt32LE(35);
                    const groupId = removeNull(slice.subarray(40, 47).toString());
                    const userId = removeNull(slice.subarray(48, 72).toString());

                    parsedUsers.push(new ZKTecoUser(
                        uid,
                        role,
                        password,
                        name || `NN-${userId}`,
                        card,
                        userId,
                        this
                    ));

                    slice = slice.subarray(72);
                }
            }

            return parsedUsers;
        };
        const users = parseUsersFromBuffer(userDataBuffer);

        let maxUid = 0;
        users.forEach(user => {
            if (user.uid > maxUid) {
                maxUid = user.uid;
            }
        });

        this.nextUid_ = maxUid + 1;
        this.nextUserId_ = (maxUid + 1).toString();

        while (users.some(u => u.userId === this.nextUserId_)) {
            maxUid++;
            this.nextUserId_ = (maxUid + 1).toString();
        }

        return users;
    }

    public async getUser(uid: number): Promise<ZKTecoUser | null> {
        const users = await this.getUsers();
        const user = users.find(user => user.uid === uid);
        return user || null;
    }

    public async getUserByUserID(userId: string): Promise<ZKTecoUser | null> {
        const users = await this.getUsers();
        const user = users.find(user => user.userId === userId);
        return user || null;
    }

    public async enableDevice(): Promise<boolean> {
        const response = await sendCommand(CMD_ENABLEDEVICE, Buffer.alloc(0), 1024, this);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }

    public async disableDevice(): Promise<boolean> {
        const response = await sendCommand(CMD_DISABLEDEVICE, Buffer.alloc(0), 1024, this);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }

    public async setTime(date: Date): Promise<boolean> {
        const time = encodeTime(date);
        const commandString = Buffer.alloc(4);
        commandString.writeUInt32LE(time, 0);
        const response = await sendCommand(CMD_SET_TIME, commandString, 1024, this);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }

    public async getAttendance(): Promise<ZKTecoAttendance[]> {
        if (this.verbose) console.log('Reading attendance records...');

        // Read sizes to get number of records
        await readSizes(this);

        if (this.verbose) console.log('Records count:', this.records);

        if (this.records === 0) {
            return [];
        }

        // Get users to map UIDs to user IDs
        const users = await this.getUsers();
        if (this.verbose) console.log('Users loaded for attendance mapping:', users.length);

        // Read attendance data with buffer
        const { data: attendanceData, size } = await readWithBuffer(CMD_ATTLOG_RRQ, undefined, undefined, this);

        if (this.verbose) console.log('Attendance data size:', size, 'bytes');

        if (size < 4) {
            if (this.verbose) console.warn('WRN: no attendance data');
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
        const isCloseToValid = (size: number) => {
            return (Math.abs(size - 8) <= 1) || (Math.abs(size - 16) <= 1) || (Math.abs(size - 40) <= 1);
        };

        // If close to valid, round to the nearest valid size
        if (isCloseToValid(recordSize)) {
            if (Math.abs(recordSize - 8) <= 1) recordSize = 8;
            else if (Math.abs(recordSize - 16) <= 1) recordSize = 16;
            else if (Math.abs(recordSize - 40) <= 1) recordSize = 40;

            if (this.verbose) {
                console.log(`Rounded to valid record size: ${recordSize}`);
            }
        } else {
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
        const attendances: ZKTecoAttendance[] = [];

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
        } else if (recordSize === 16) {
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
        } else {
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

                if (dataBuffer.length < 40) break;

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

        if (this.verbose) console.log('Parsed', attendances.length, 'attendance records');
        return attendances;
    }

    /**
     * 
     * @param index 
     * 0 Thank You\n
     * 1 Incorrect Password\n
     * 2 Access Denied\n
     * 3 Invalid ID\n
     * 4 Please try again\n
     * 5 Dupicate ID\n
     * 6 The clock is flow\n
     * 7 The clock is full\n
     * 8 Duplicate finger\n
     * 9 Duplicated punch\n
     * 10 Beep kuko\n
     * 11 Beep siren\n
     * 12 -\n
     * 13 Beep bell\n
     * 14 -\n
     * 15 -\n
     * 16 -\n
     * 17 -\n
     * 18 Windows(R) opening sound\n
     * 19 -\n
     * 20 Fingerprint not emolt\n
     * 21 Password not emolt\n
     * 22 Badges not emolt\n
     * 23 Face not emolt\n
     * 24 Beep standard\n
     * 25 -\n
     * 26 -\n
     * 27 -\n
     * 28 -\n
     * 29 -\n
     * 30 Invalid user\n
     * 31 Invalid time period\n
     * 32 Invalid combination\n
     * 33 Illegal Access\n
     * 34 Disk space full\n
     * 35 Duplicate fingerprint\n
     * 36 Fingerprint not registered\n
     * 37 -\n
     * 38 -\n
     * 39 -\n
     * 40 -\n
     * 41 -\n
     * 42 -\n
     * 43 -\n
     * 44 -\n
     * 45 -\n
     * 46 -\n
     * 47 -\n
     * 48 -\n
     * 49 -\n
     * 50 -\n
     * 51 Focus eyes on the green box\n
     * 52 -\n
     * 53 -\n
     * 54 -\n
     * 55 -\n
     * @returns 
     */
    public async testVoice(index: number = 0): Promise<boolean> {
        const commandString = Buffer.alloc(4);
        commandString.writeUInt32LE(index, 0);
        const response = await sendCommand(CMD_TESTVOICE, commandString, 1024, this);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }

    /**
     * Get all fingerprint templates from the device
     * @returns Array of ZKTecoFinger objects
     */
    public async getTemplates(): Promise<ZKTecoFinger[]> {
        if (this.verbose) console.log('Reading fingerprint templates...');

        await readSizes(this);

        if (this.fingers === 0) {
            return [];
        }

        const { data: templateData, size } = await readWithBuffer(CMD_DB_RRQ, FCT_FINGERTMP, undefined, this);

        if (this.verbose) console.log('Template data size:', size, 'bytes');

        if (size < 4) {
            if (this.verbose) console.warn('WRN: no template data');
            return [];
        }

        const templates: ZKTecoFinger[] = [];

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
                if (this.verbose) console.log('Invalid template size:', templateSize);
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

        if (this.verbose) console.log('Parsed', templates.length, 'fingerprint templates');
        return templates;
    }

    /**
     * Get a specific user's fingerprint template
     * @param uid - User's UID (device-generated ID)
     * @param tempId - Finger index (0-9)
     * @param userId - Optional user ID string (will lookup UID if provided without uid)
     * @returns ZKTecoFinger object or null if not found
     */
    public async getUserTemplate(uid: number = 0, tempId: number = 0, userId: string = ''): Promise<ZKTecoFinger | null> {
        if (this.verbose) console.log(`Getting template for uid=${uid}, tempId=${tempId}, userId=${userId}`);

        // If uid is not provided, lookup by userId
        if (!uid && userId) {
            const users = await this.getUsers();
            const user = users.find(u => u.userId === userId);
            if (!user) {
                if (this.verbose) console.log('User not found:', userId);
                return null;
            }
            uid = user.uid;
        }

        if (!uid) {
            if (this.verbose) console.log('No UID provided');
            return null;
        }

        // Try up to 3 times
        for (let retry = 0; retry < 3; retry++) {
            try {
                // Pack command: uid (2 bytes) + temp_id (1 byte)
                const commandString = Buffer.alloc(3);
                commandString.writeInt16LE(uid, 0);
                commandString.writeInt8(tempId, 2);

                const response = await sendCommand(_CMD_GET_USERTEMP, commandString, 1024 + 8, this);

                if (!response) {
                    if (this.verbose) console.log('No response, retry', retry + 1);
                    continue;
                }

                // Receive the chunk data
                const data = await receiveChunk(this);

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

                if (this.verbose) console.log('Retry get_user_template', retry + 1);
            } catch (e) {
                if (this.verbose) console.log('Error getting template:', e);
            }
        }

        if (this.verbose) console.log("Can't read/find finger");
        return null;
    }

    /**
     * Delete a specific user's fingerprint template
     * @param uid - User's UID (device-generated ID)
     * @param tempId - Finger index (0-9)
     * @param userId - Optional user ID string (will lookup UID if provided without uid)
     * @returns true if deleted successfully, false otherwise
     */
    public async refreshData(): Promise<boolean> {
        const response = await sendCommand(CMD_REFRESHDATA, Buffer.alloc(0), 1024, this);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }

    public async deleteUserTemplate(uid: number = 0, tempId: number = 0, userId: string = ''): Promise<boolean> {
        if (this.verbose) console.log(`Deleting template for uid=${uid}, tempId=${tempId}, userId=${userId}`);

        // TCP mode with userId - use the special command
        if (this.socket instanceof net.Socket && userId) {
            // Pack command: user_id (24 bytes) + temp_id (1 byte)
            const commandString = Buffer.alloc(25);
            commandString.write(userId, 0, 24, 'utf8');
            commandString.writeUInt8(tempId, 24);

            const response = await sendCommand(_CMD_DEL_USER_TEMP, commandString, 1024, this);

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
                if (this.verbose) console.log('User not found:', userId);
                return false;
            }
            uid = user.uid;
        }

        if (!uid) {
            if (this.verbose) console.log('No UID provided');
            return false;
        }

        // Pack command: uid (2 bytes) + temp_id (1 byte)
        const commandString = Buffer.alloc(3);
        commandString.writeInt16LE(uid, 0);
        commandString.writeInt8(tempId, 2);

        const response = await sendCommand(CMD_DELETE_USERTEMP, commandString, 1024, this);

        if (response && response.length >= 2) {
            const responseCode = response.readUInt16LE(0);
            return responseCode === CMD_ACK_OK;
        }
        return false;
    }

    // Live capture would require event emitter or callback mechanism
    // For now, just a placeholder or basic implementation if requested
    public async startLiveCapture(): Promise<void> {
        // TODO: Implement live capture loop
    }

    public async restart(): Promise<boolean> {
        const response = await sendCommand(CMD_RESTART, Buffer.alloc(0), 1024, this);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }

    public async unlock(time: number = 3): Promise<boolean> {
        const commandString = Buffer.alloc(4);
        commandString.writeUInt32LE(time * 10, 0); // Delay in tenths of seconds? Python says int(time)*10
        const response = await sendCommand(CMD_UNLOCK, commandString, 1024, this);
        return response !== null && response.readUInt16LE(0) === CMD_ACK_OK;
    }

    public async setUser(uid: number, name: string, privilege: number, password: string, groupId: string, userId: string, card: number): Promise<boolean> {
        if (this.verbose) {
            console.log(`Setting user: uid=${uid}, name='${name}', privilege=${privilege}, password=${password}, groupId='${groupId}', userId='${userId}', card=${card}`);
        }

        // Enable device first
        await this.enableDevice();

        let finalUid = uid;
        let finalUserId = userId;
        let finalGroupId = groupId;

        if (this.nextUid_ <= 1) {
            this.nextUid_ = await this.getMaxUid() + 1;

        }

        if (finalUid === 0) {
            finalUid = this.nextUid_;
            if (!finalUserId) {
                finalUserId = this.nextUserId_;
            }
        }

        if (!finalUserId) {
            finalUserId = finalUid.toString();
        }

        if (privilege !== USER_DEFAULT && privilege !== USER_ADMIN) {
            privilege = USER_DEFAULT;
        }

        if (this.verbose) {
            console.log(`Setting user: uid=${finalUid}, name='${name}', privilege=${privilege}, password=${password}, groupId='${finalGroupId}', userId='${finalUserId}', card=${card}`);
        }

        let commandString: Buffer;

        if (this.userPacketSize_ === 28) {
            if (!finalGroupId) {
                finalGroupId = "0";
            }

            // 28 bytes packet
            commandString = Buffer.alloc(28);

            // Offset 0-1: uid (2 bytes)
            commandString.writeUInt16LE(finalUid, 0);

            // Offset 2: privilege (1 byte)
            commandString.writeUInt8(privilege, 2);

            // Offset 3-7: password (5 bytes)
            commandString.write(password, 3, 5);

            // Offset 8-15: name (8 bytes)
            commandString.write(name, 8, 8);

            // Offset 16-19: card (4 bytes)
            commandString.writeUInt32LE(card, 16);

            // Offset 20: padding (1 byte)

            // Offset 21: group_id (1 byte)
            const groupIdInt = parseInt(finalGroupId) || 0;
            commandString.writeUInt8(groupIdInt, 21);

            // Offset 22-23: timezone (2 bytes)
            commandString.writeUInt16LE(0, 22);

            // Offset 24-27: user_id (4 bytes)
            const userIdInt = parseInt(finalUserId) || 0;
            commandString.writeUInt32LE(userIdInt, 24);

        } else {
            // 72 bytes packet (default)
            commandString = Buffer.alloc(72);

            // Offset 0-1: uid (2 bytes)
            commandString.writeUInt16LE(finalUid, 0);

            // Offset 2: privilege (1 byte)
            commandString.writeUInt8(privilege, 2);

            // Offset 3-10: password (8 bytes)
            commandString.write(password, 3, 8);

            // Offset 11-34: name (24 bytes)
            commandString.write(name, 11, 24);

            // Offset 35-38: card (4 bytes)
            commandString.writeUInt32LE(card, 35);

            // Offset 39: group_id (1 byte)
            const groupIdInt = parseInt(finalGroupId) || 0;
            commandString.writeUInt8(groupIdInt, 39);

            // Offset 40-46: group_id string (7 bytes)
            const groupIdStr = finalGroupId || "0";
            commandString.write(groupIdStr, 40, 7);

            // Offset 47: padding (1 byte)

            // Offset 48-71: user_id string (24 bytes)
            commandString.write(finalUserId, 48, 24);
        }

        if (this.verbose) console.log('Command string hex:', commandString.toString('hex'));

        const response = await sendCommand(CMD_USER_WRQ, commandString, 1024, this);

        if (this.verbose && response) console.log('Response hex:', response.toString('hex'));

        if (response !== null && (response.readUInt16LE(0) === CMD_ACK_OK || response.readUInt16LE(0) === CMD_ACK_DATA)) {
            if (this.nextUid_ === finalUid) {
                this.nextUid_++;
            }
            if (this.nextUserId_ === finalUserId) {
                this.nextUserId_ = this.nextUid_.toString();
            }
            return true;
        }

        return false;
    }
    public async getMaxUid() {
        var toReturn = 0;

        var users = await this.getUsers();
        users.forEach(user => {
            if (user.uid > toReturn) {
                toReturn = user.uid;
            }
        });

        return toReturn;
    }

    public async deleteUser(uid: number): Promise<boolean> {
        const commandString = Buffer.alloc(2);
        commandString.writeUInt16LE(uid, 0);
        const response = await sendCommand(CMD_DELETE_USER, commandString, 1024, this);

        if (response !== null && response.readUInt16LE(0) === CMD_ACK_OK) {
            if (uid === (this.nextUid_ - 1)) {
                this.nextUid_ = uid;
            }
            return true;
        }
        return false;
    }

}

export { ZKTecoClient };
