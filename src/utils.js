import { Buffer } from 'buffer';
import { USHRT_MAX, MACHINE_PREPARE_DATA_1, MACHINE_PREPARE_DATA_2 } from './constants.js';
export const createChecksum = (packet) => {
    let checksum = 0;
    let l = packet.length;
    let i = 0;
    while (l > 1) {
        checksum += (packet[i] + (packet[i + 1] << 8));
        i += 2;
        if (checksum > USHRT_MAX) {
            checksum -= USHRT_MAX;
        }
        l -= 2;
    }
    if (l > 0) {
        checksum += packet[i];
    }
    while (checksum > USHRT_MAX) {
        checksum -= USHRT_MAX;
    }
    checksum = ~checksum;
    return checksum & USHRT_MAX;
};
export const createHeader = (command, commandString, sessionId, replyId) => {
    const buf = Buffer.alloc(8 + commandString.length);
    buf.writeUInt16LE(command, 0);
    buf.writeUInt16LE(0, 2); // Checksum placeholder
    buf.writeUInt16LE(sessionId, 4);
    buf.writeUInt16LE(replyId, 6);
    commandString.copy(buf, 8);
    const checksum = createChecksum(buf);
    buf.writeUInt16LE(checksum, 2);
    return buf;
};
export const createTcpTop = (packet) => {
    const length = packet.length;
    const top = Buffer.alloc(8);
    top.writeUInt16LE(MACHINE_PREPARE_DATA_1, 0);
    top.writeUInt16LE(MACHINE_PREPARE_DATA_2, 2);
    top.writeUInt32LE(length, 4);
    return Buffer.concat([top, packet]);
};
export const testTcpTop = (packet) => {
    if (packet.length <= 8)
        return 0;
    const header1 = packet.readUInt16LE(0);
    const header2 = packet.readUInt16LE(2);
    const length = packet.readUInt32LE(4);
    if (header1 === MACHINE_PREPARE_DATA_1 && header2 === MACHINE_PREPARE_DATA_2) {
        return length;
    }
    return 0;
};
export const makeCommKey = (key, sessionId, ticks = 50) => {
    let k = 0;
    for (let i = 0; i < 32; i++) {
        if ((key & (1 << i))) {
            k = (k << 1) | 1;
        }
        else {
            k = k << 1;
        }
    }
    k += sessionId;
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(k, 0);
    // XOR with 'ZKSO'
    buf[0] ^= 'Z'.charCodeAt(0);
    buf[1] ^= 'K'.charCodeAt(0);
    buf[2] ^= 'S'.charCodeAt(0);
    buf[3] ^= 'O'.charCodeAt(0);
    // Swap and XOR with ticks
    const b = 0xff & ticks;
    // swap 0 and 2
    const temp0 = buf[0];
    buf[0] = buf[2];
    buf[2] = temp0;
    // swap 1 and 3
    const temp1 = buf[1];
    buf[1] = buf[3];
    buf[3] = temp1;
    buf[0] ^= b;
    buf[1] ^= b;
    buf[2] = b;
    buf[3] ^= b;
    return buf;
};
export const decodeTime = (timeBytes) => {
    let t = timeBytes.readUInt32LE(0);
    const second = t % 60;
    t = Math.floor(t / 60);
    const minute = t % 60;
    t = Math.floor(t / 60);
    const hour = t % 24;
    t = Math.floor(t / 24);
    const day = (t % 31) + 1;
    t = Math.floor(t / 31);
    const month = (t % 12) + 1;
    t = Math.floor(t / 12);
    const year = t + 2000;
    return new Date(year, month - 1, day, hour, minute, second);
};
export const encodeTime = (date) => {
    return (((date.getFullYear() % 100) * 12 * 31 + ((date.getMonth() + 1) - 1) * 31 + date.getDate() - 1) *
        (24 * 60 * 60) +
        (date.getHours() * 60 + date.getMinutes()) * 60 +
        date.getSeconds());
};
export const removeNull = (str) => {
    // Stop at the first null byte to prevent buffer contamination from previous records
    const nullIndex = str.indexOf('\u0000');
    if (nullIndex !== -1) {
        return str.substring(0, nullIndex).trim();
    }
    return str.trim();
};
//# sourceMappingURL=utils.js.map