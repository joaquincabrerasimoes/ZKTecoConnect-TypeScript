# ZKTecoConnect-TypeScript

## Project Overview

ZKTecoConnect-TypeScript is a TypeScript SDK for communicating with ZKTeco biometric attendance devices (access control and time-tracking systems). It provides a robust client library for integrating ZKTeco devices into Node.js/TypeScript applications.

## Technology Stack

- **Language**: TypeScript 5.9.3 (strict mode enabled)
- **Runtime**: Node.js (CommonJS modules, ES2020 target)
- **Build**: TypeScript Compiler (tsc)
- **Development**: ts-node 10.9.2
- **Type Definitions**: @types/node 24.10.1
- **License**: MIT

## Project Structure

```
src/
├── index.ts                     # Public API exports
├── objects/                     # Core domain objects
│   ├── zkTecoClient.ts          # Main client class (1245 lines)
│   ├── zkTecoUser.ts            # User model with methods
│   └── zkTecoAttendance.ts      # Attendance record model
├── others/                      # Enums, interfaces, constants
│   ├── constants.ts             # Command codes, response codes, event flags
│   ├── enums.ts                 # ZKAttendanceIDMethod, ZKSound (56 sounds)
│   └── interfaces.ts            # TypeScript interfaces
└── utils/                       # Utility functions
    ├── utils.ts                 # Crypto, time encoding, packet building
    └── generalFunctions.ts      # Socket operations, packet parsing
examples/                        # Reference implementations (Python, C++)
```

## Build Commands

```bash
npm run build    # TypeScript compilation
npm test         # Run tests (if configured)
```

## Development Rules

### TypeScript Standards
- Use strict mode (enabled in tsconfig.json)
- Define proper TypeScript interfaces for all data structures
- Use async/await for all asynchronous operations
- Handle errors with try/catch blocks
- Leverage noUncheckedIndexedAccess and exactOptionalPropertyTypes for type safety

### Binary Protocol
- Follow existing packet structure conventions
- Use Buffer for all binary data handling
- Maintain checksum validation for all packets
- Document command codes in constants.ts
- TCP Top Header: 8 bytes (magic 0x5050, 0x7282 + length)
- Command Packet: 8-byte header + payload
- 16-bit checksum as complement of sum of 16-bit words
- Custom time encoding (year/month/day/hour/minute/second to 32-bit integer)

### Socket Management
- Properly clean up event listeners after operations
- Use configurable timeouts per command
- Track connection state
- Graceful error handling with fallbacks

### Data Format Handling
- Auto-detect packet format variations (device model differences)
- Handle variable-length data gracefully
- Provide fallbacks for unknown formats
- Auto-detects user packet format (28/72 bytes)
- Auto-detects attendance record format (8/16/40 bytes)
- Handles variable-length fingerprint templates
- Graceful handling of header offset variations

### Code Organization
- Keep ZKTecoClient as main orchestrator
- Domain objects (User, Attendance) should be lightweight
- Utility functions in utils/ directory
- Constants and enums in others/ directory

### Testing
- Test against multiple device models if possible
- Verify checksum calculations
- Test timeout handling

## Main Features

### ZKTecoClient (Core Class)

**Connection Management:**
- `connect()` - Establish TCP/UDP connection with authentication
- `disconnect()` - Graceful disconnect
- Supports both TCP and UDP protocols

**Device Information:**
- `getDeviceInfo()` - Comprehensive device data bundle
- `getFirmwareVersion()`, `getSerialNumber()`, `getPlatform()`
- `getDeviceName()`, `getMacAddress()`, `getDeviceTime()`
- `getMemoryInfo()` - Storage capacity and usage

**User Management:**
- `getUsers()` - Retrieve all users (handles 28-byte and 72-byte formats)
- `getUser(uid)`, `getUserByUserID(userId)` - Get specific user
- `setUser()` - Create/update user with comprehensive parameters
- `deleteUser(uid)` - Remove user from device

**Attendance Management:**
- `getAttendance()` - Retrieve all records (8, 16, 40-byte formats)
- `clearAttendance()` - Clear attendance log

**Fingerprint Templates:**
- `getTemplates()` - Get all fingerprint templates
- `getUserTemplate()` - Get specific user's template
- `deleteUserTemplate()` - Remove template

**Live Event Capture:**
- `startLiveCapture()` - Begin real-time event monitoring
- `getNextLiveEvent()` - Poll for next attendance event
- `stopLiveCapture()` - End monitoring

**Device Control:**
- `enableDevice()` / `disableDevice()` - Control input
- `setTime()` - Synchronize device time
- `restart()` - Reboot device
- `unlock()` - Trigger door unlock
- `testVoice()` - Play device sounds (56 options)

### Supporting Classes
- **ZKTecoUser**: User with attendance/template methods
- **ZKTecoAttendance**: Attendance record with formatting, JSON serialization

## Authentication Protocol

1. Device responds CMD_ACK_UNAUTH (2005)
2. Client generates auth key via `makeCommKey()` (XOR encryption)
3. Sends CMD_AUTH (1102) with encrypted key
4. Device responds CMD_ACK_OK (2000)

## No External Runtime Dependencies

Only Node.js built-in modules (net, dgram, buffer). All dev dependencies are for build/type checking only.

## Usage Example

```typescript
import { ZKTecoClient } from 'zktecoconnect-typescript';

const client = new ZKTecoClient('192.168.1.100', 4370);
await client.connect();
const users = await client.getUsers();
const attendance = await client.getAttendance();
await client.disconnect();
```

## Repository

- **GitHub**: https://github.com/joaquincabrerasimoes/ZKTecoConnect-TypeScript
- **Issues**: https://github.com/joaquincabrerasimoes/ZKTecoConnect-TypeScript/issues
