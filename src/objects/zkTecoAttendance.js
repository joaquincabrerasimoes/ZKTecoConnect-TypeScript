"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZKTecoAttendance = void 0;
const enums_1 = require("../others/enums");
class ZKTecoAttendance {
    constructor(userId, uid, timestamp, idMethod, punch) {
        this.userId = userId;
        this.uid = uid;
        this.timestamp = timestamp;
        this.idMethod = idMethod;
        this.punch = punch;
    }
    get identificationMethod() {
        switch (this.idMethod) {
            case 0:
                return enums_1.ZKAttendanceIDMethod.empty;
            case 1:
                return enums_1.ZKAttendanceIDMethod.fingerprint;
            case 2:
                return enums_1.ZKAttendanceIDMethod.face;
            case 3:
                return enums_1.ZKAttendanceIDMethod.password;
            case 4:
                return enums_1.ZKAttendanceIDMethod.card;
            default:
                return enums_1.ZKAttendanceIDMethod.empty;
        }
    }
    /// Get a human-readable string for the identification method
    get identificationMethodString() {
        switch (this.identificationMethod) {
            case enums_1.ZKAttendanceIDMethod.empty:
                return 'Unknown';
            case enums_1.ZKAttendanceIDMethod.fingerprint:
                return 'Fingerprint';
            case enums_1.ZKAttendanceIDMethod.face:
                return 'Face Recognition';
            case enums_1.ZKAttendanceIDMethod.password:
                return 'Password';
            case enums_1.ZKAttendanceIDMethod.card:
                return 'Card/RFID';
        }
    }
    /// Get an icon for the identification method
    get identificationMethodIcon() {
        switch (this.identificationMethod) {
            case enums_1.ZKAttendanceIDMethod.empty:
                return '❓';
            case enums_1.ZKAttendanceIDMethod.fingerprint:
                return '👆';
            case enums_1.ZKAttendanceIDMethod.face:
                return '😊';
            case enums_1.ZKAttendanceIDMethod.password:
                return '🔢';
            case enums_1.ZKAttendanceIDMethod.card:
                return '💳';
        }
    }
    toString() {
        return `ZKAttendance(uid: ${this.uid}, userId: ${this.userId}, timestamp: ${this.timestamp}, method: ${this.identificationMethodString}, punch: ${this.punch})`;
    }
    toJson() {
        return {
            'uid': this.uid,
            'userId': this.userId,
            'timestamp': this.timestamp,
            'idMethod': this.idMethod,
            'punch': this.punch,
        };
    }
}
exports.ZKTecoAttendance = ZKTecoAttendance;
//# sourceMappingURL=zkTecoAttendance.js.map