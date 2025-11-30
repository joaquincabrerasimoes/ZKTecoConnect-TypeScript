import { Buffer } from 'buffer';

const USHRT_MAX = 65535;

const createChecksum = (packet) => {
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

    while (checksum < 0) {
        checksum += USHRT_MAX;
    }

    return checksum & USHRT_MAX;
};

const buf = Buffer.alloc(8);
buf.writeUInt16LE(1000, 0); // CMD_CONNECT
buf.writeUInt16LE(0, 2); // Checksum placeholder
buf.writeUInt16LE(0, 4); // Session ID
buf.writeUInt16LE(0, 6); // Reply ID

const checksum = createChecksum(buf);
console.log('Checksum:', checksum.toString(16));
console.log('Buffer:', buf.toString('hex'));
