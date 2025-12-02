import * as net from 'net';
import * as dgram from 'dgram';
import { Buffer } from 'buffer';
import type { ZKTecoDeviceInfo, ZKTecoFinger } from '../others/interfaces';
import { ZKTecoUser } from './zkTecoUser';
import { ZKTecoAttendance } from './zkTecoAttendance';
import { ZKSound } from '../others/enums';
declare class ZKTecoClient {
    ip: string;
    port: number;
    timeout: number;
    password: number;
    forceUdp: boolean;
    verbose: boolean;
    socket: net.Socket | dgram.Socket | null;
    isConnected: boolean;
    sessionId: number;
    replyId: number;
    tcpLength: number;
    lastResponse: number;
    lastData: Buffer;
    pendingLiveData: Buffer;
    nextUid_: number;
    nextUserId_: string;
    userPacketSize_: number;
    liveCaptureActive: boolean;
    liveCaptureTimeoutMs: number;
    liveCaptureUsers: ZKTecoUser[];
    liveCaptureUserMap: Map<string, number>;
    liveEventBuffer: Buffer;
    liveEventQueue: ZKTecoAttendance[];
    wasEnabledBeforeLiveCapture: boolean;
    users: number;
    fingers: number;
    records: number;
    usersCapacity: number;
    fingersCapacity: number;
    recordsCapacity: number;
    constructor(ip: string, port: number, timeout: number, password: number, forceUdp: boolean | null, verbose: boolean | null);
    connect(): Promise<boolean>;
    disconnect(): Promise<boolean>;
    getDeviceInfo(): Promise<ZKTecoDeviceInfo>;
    getFirmwareVersion(): Promise<string>;
    getSerialNumber(): Promise<string>;
    getPlatform(): Promise<string>;
    getDeviceName(): Promise<string>;
    getMacAddress(): Promise<string>;
    getFaceVersion(): Promise<number>;
    getFpVersion(): Promise<number>;
    getDeviceTime(): Promise<Date>;
    getMemoryInfo(): Promise<{
        usedUsers: number;
        totalUsers: number;
        usedFingers: number;
        totalFingers: number;
        usedRecords: number;
        totalRecords: number;
    } | null>;
    getUsers(): Promise<ZKTecoUser[]>;
    getUser(uid: number): Promise<ZKTecoUser | null>;
    getUserByUserID(userId: string): Promise<ZKTecoUser | null>;
    enableDevice(): Promise<boolean>;
    disableDevice(): Promise<boolean>;
    setTime(date: Date): Promise<boolean>;
    getAttendance(): Promise<ZKTecoAttendance[]>;
    clearAttendance(): Promise<boolean>;
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
    testVoice(index?: ZKSound): Promise<boolean>;
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
    refreshData(): Promise<boolean>;
    deleteUserTemplate(uid?: number, tempId?: number, userId?: string): Promise<boolean>;
    startLiveCapture(timeoutSeconds?: number): Promise<boolean>;
    getNextLiveEvent(timeoutMs?: number): Promise<ZKTecoAttendance | null>;
    stopLiveCapture(): Promise<boolean>;
    restart(): Promise<boolean>;
    unlock(time?: number): Promise<boolean>;
    setUser(uid: number, name: string, privilege: number, password: string, groupId: string, userId: string, card: number): Promise<boolean>;
    getMaxUid(): Promise<number>;
    deleteUser(uid: number): Promise<boolean>;
}
export { ZKTecoClient };
//# sourceMappingURL=zkTecoClient.d.ts.map