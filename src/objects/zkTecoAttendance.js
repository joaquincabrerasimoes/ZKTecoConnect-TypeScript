var ZKAttendanceStatus;
(function (ZKAttendanceStatus) {
    ZKAttendanceStatus[ZKAttendanceStatus["empty"] = 0] = "empty";
    ZKAttendanceStatus[ZKAttendanceStatus["fingerprint"] = 1] = "fingerprint";
    ZKAttendanceStatus[ZKAttendanceStatus["face"] = 2] = "face";
    ZKAttendanceStatus[ZKAttendanceStatus["password"] = 3] = "password";
    ZKAttendanceStatus[ZKAttendanceStatus["card"] = 4] = "card";
})(ZKAttendanceStatus || (ZKAttendanceStatus = {}));
class ZKTecoAttendance {
    userId;
    uid;
    timestamp;
    status;
    punch;
    constructor(userId, uid, timestamp, status, punch) {
        this.userId = userId;
        this.uid = uid;
        this.timestamp = timestamp;
        this.status = status;
        this.punch = punch;
    }
    get identificationMethod() {
        switch (this.status) {
            case 0:
                return ZKAttendanceStatus.empty;
            case 1:
                return ZKAttendanceStatus.fingerprint;
            case 2:
                return ZKAttendanceStatus.face;
            case 3:
                return ZKAttendanceStatus.password;
            case 4:
                return ZKAttendanceStatus.card;
            default:
                return ZKAttendanceStatus.empty;
        }
    }
    /// Get a human-readable string for the identification method
    get identificationMethodString() {
        switch (this.identificationMethod) {
            case ZKAttendanceStatus.empty:
                return 'Unknown';
            case ZKAttendanceStatus.fingerprint:
                return 'Fingerprint';
            case ZKAttendanceStatus.face:
                return 'Face Recognition';
            case ZKAttendanceStatus.password:
                return 'Password';
            case ZKAttendanceStatus.card:
                return 'Card/RFID';
        }
    }
    /// Get an icon for the identification method
    get identificationMethodIcon() {
        switch (this.identificationMethod) {
            case ZKAttendanceStatus.empty:
                return '❓';
            case ZKAttendanceStatus.fingerprint:
                return '👆';
            case ZKAttendanceStatus.face:
                return '😊';
            case ZKAttendanceStatus.password:
                return '🔢';
            case ZKAttendanceStatus.card:
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
            'status': this.status,
            'punch': this.punch,
        };
    }
}
export { ZKTecoAttendance };
//# sourceMappingURL=zkTecoAttendance.js.map