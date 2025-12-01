enum ZKAttendanceStatus {
  empty, // 0
  fingerprint, // 1
  face, // 2
  password, // 3
  card, // 4
}

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

    public get identificationMethod(): ZKAttendanceStatus {
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
  public get identificationMethodString(): string {
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
  public get identificationMethodIcon(): string {
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