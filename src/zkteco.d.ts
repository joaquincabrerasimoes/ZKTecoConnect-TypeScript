import type { ZKTecoDeviceInfo, ZKTecoUser, ZKTecoAttendance, ZKTecoFinger } from './types.js';
export declare class ZKTeco {
    private ip;
    private port;
    private timeout;
    private password;
    private forceUdp;
    private verbose;
    private socket;
    private isConnected;
    private sessionId;
    private replyId;
    private tcpLength;
    private lastResponse;
    private lastData;
    private users;
    private fingers;
    private records;
    private usersCapacity;
    private fingersCapacity;
    private recordsCapacity;
    constructor(ip: string, port?: number, timeout?: number, password?: number, forceUdp?: boolean, verbose?: boolean);
    connect(): Promise<boolean>;
    disconnect(): Promise<boolean>;
    private createSocket;
    private closeSocket;
    private sendCommand;
    getDeviceInfo(): Promise<ZKTecoDeviceInfo>;
    getFirmwareVersion(): Promise<string>;
    getSerialNumber(): Promise<string>;
    getPlatform(): Promise<string>;
    getDeviceName(): Promise<string>;
    getMacAddress(): Promise<string>;
    getFaceVersion(): Promise<number>;
    getFpVersion(): Promise<number>;
    getDeviceTime(): Promise<Date>;
    getUsers(): Promise<ZKTecoUser[]>;
    getMemoryInfo(): Promise<{
        usedUsers: number;
        totalUsers: number;
        usedFingers: number;
        totalFingers: number;
        usedRecords: number;
        totalRecords: number;
    } | null>;
    private readSizes;
    private receiveRawData;
    private getDataSize;
    private receiveChunk;
    private readChunk;
    private readWithBuffer;
    private freeData;
    setUser(uid: number, name: string, password: string, role?: number, card?: number): Promise<boolean>;
    deleteUser(uid: number): Promise<boolean>;
    getAttendance(): Promise<ZKTecoAttendance[]>;
    restart(): Promise<boolean>;
    unlock(time?: number): Promise<boolean>;
    enableDevice(): Promise<boolean>;
    disableDevice(): Promise<boolean>;
    setTime(date: Date): Promise<boolean>;
    testVoice(index?: number): Promise<boolean>;
    startLiveCapture(): Promise<void>;
    /**
     * Get all fingerprint templates from the device
     * @returns Array of ZKTecoFinger objects
     */
    getTemplates(): Promise<ZKTecoFinger[]>;
    /**
     * Get a specific user's fingerprint template
     * @param uid - User's UID (device-generated ID)
     * @param tempId - Finger index (0-9)
     * @param userId - Optional user ID string (will lookup UID if provided without uid)
     * @returns ZKTecoFinger object or null if not found
     */
    getUserTemplate(uid?: number, tempId?: number, userId?: string): Promise<ZKTecoFinger | null>;
    /**
     * Delete a specific user's fingerprint template
     * @param uid - User's UID (device-generated ID)
     * @param tempId - Finger index (0-9)
     * @param userId - Optional user ID string (will lookup UID if provided without uid)
     * @returns true if deleted successfully, false otherwise
     */
    deleteUserTemplate(uid?: number, tempId?: number, userId?: string): Promise<boolean>;
}
//# sourceMappingURL=zkteco.d.ts.map