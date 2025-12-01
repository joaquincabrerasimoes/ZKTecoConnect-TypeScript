import { ZKAttendanceIDMethod } from '../others/enums.js';

class ZKTecoAttendance {
    userId: string;
    uid: number;
    timestamp: Date;
    status: number;
    punch: number;

    constructor(userId: string, uid: number, timestamp: Date, status: number, punch: number) {
        this.userId = userId;
        this.uid = uid;
        this.timestamp = timestamp;
        this.status = status;
        this.punch = punch;
    }

    public get identificationMethod(): ZKAttendanceIDMethod {
        switch (this.status) {
          case 0:
            return ZKAttendanceIDMethod.empty;
          case 1:
            return ZKAttendanceIDMethod.fingerprint;
          case 2:
            return ZKAttendanceIDMethod.face;
          case 3:
            return ZKAttendanceIDMethod.password;
          case 4:
            return ZKAttendanceIDMethod.card;
          default:
            return ZKAttendanceIDMethod.empty;
        }
      }

      /// Get a human-readable string for the identification method
  public get identificationMethodString(): string {
    switch (this.identificationMethod) {
      case ZKAttendanceIDMethod.empty:
        return 'Unknown';
      case ZKAttendanceIDMethod.fingerprint:
        return 'Fingerprint';
      case ZKAttendanceIDMethod.face:
        return 'Face Recognition';
      case ZKAttendanceIDMethod.password:
        return 'Password';
      case ZKAttendanceIDMethod.card:
        return 'Card/RFID';
    }
  }

  /// Get an icon for the identification method
  public get identificationMethodIcon(): string {
    switch (this.identificationMethod) {
      case ZKAttendanceIDMethod.empty:
        return '❓';
      case ZKAttendanceIDMethod.fingerprint:
        return '👆';
      case ZKAttendanceIDMethod.face:
        return '😊';
      case ZKAttendanceIDMethod.password:
        return '🔢';
      case ZKAttendanceIDMethod.card:
        return '💳';
    }
  }

  public toString(): string {
    return `ZKAttendance(uid: ${this.uid}, userId: ${this.userId}, timestamp: ${this.timestamp}, method: ${this.identificationMethodString}, punch: ${this.punch})`;
  }

  public toJson(): Record<string, any> {
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