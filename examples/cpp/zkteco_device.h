#pragma once

// Must define WIN32_LEAN_AND_MEAN before including Windows headers
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

// Prevent min/max macro conflicts
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <string>
#include <vector>
#include <memory>
#include <queue>

// Include Winsock headers in correct order
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

// Include ZKTeco classes
#include "objects/zkteco_user.h"
#include "objects/zkteco_const.h"
#include "objects/zkteco_finger.h"
#include "objects/zkteco_attendance.h"
#include "objects/zkteco_device_info.h"

// Forward declarations
class ZKTecoUser;
class ZKTecoAttendance;

class ZKTecoDevice {
public:
    ZKTecoDevice(const std::string& address, int port, int timeout = 60, 
                 int password = 0, bool forceUdp = false, bool verbose = false);
    ~ZKTecoDevice();

    // Connection management
    bool Connect();
    bool Disconnect();
    bool IsConnected() const { return isConnected_; }

    // Device information
    ZKTecoDeviceInfo GetDeviceInfo();
    std::string GetFirmwareVersion();
    std::string GetSerialNumber();
    std::string GetPlatform();
    std::string GetDeviceName();
    std::string GetMacAddress();
    std::string GetFaceVersion();
    std::string GetFpVersion();
    std::string GetDeviceTime();
    std::vector<ZKTecoUser> GetUsers();
    
    // Attendance management
    std::vector<ZKTecoAttendance> GetAttendance();
    
    // Template management
    std::vector<ZKTecoFinger> GetTemplates();
    ZKTecoFinger* GetUserTemplate(int uid = 0, int tempId = 0, const std::string& userId = "");
    
    // User management
    bool SetUser(int uid, const std::string& name, int privilege, int password, 
                 const std::string& groupId, const std::string& userId, int card);
    bool DeleteUser(int uid, const std::string& userId);
    bool DeleteUserTemplate(int uid, int tempId, const std::string& userId);
    
    // Voice testing
    bool TestVoice(int index);
    
    // Live capture functionality
    bool StartLiveCapture(int timeout = 10);
    ZKTecoAttendance GetNextLiveEvent();
    bool StopLiveCapture();
    bool IsLiveCaptureActive() const { return liveCaptureActive_; }
    
    // Device control
    bool GetLockState();
    bool Restart();
    bool Unlock(int time);
    bool EnableDevice();
    bool DisableDevice();
    bool SetTime(time_t timestamp);
    bool SetDeviceName(const std::string& deviceName);
    
    // Data size checking
    int GetDataSize();
    void ReadSizes();

    // Detailed memory information
    struct MemoryInfo {
        int usedUsers;
        int totalUsers;
        int availableUsers;
        int usedFingers;
        int totalFingers;
        int availableFingers;
        int usedRecords;
        int totalRecords;
        int availableRecords;
        int usedCards;
        int usedFaces;
        int totalFaces;
        int availableFaces;
        int dummy;
        bool success;
        std::string debugInfo; // For debugging information
        
        MemoryInfo() : usedUsers(0), totalUsers(0), availableUsers(0),
                       usedFingers(0), totalFingers(0), availableFingers(0),
                       usedRecords(0), totalRecords(0), availableRecords(0),
                       usedCards(0), usedFaces(0), totalFaces(0), availableFaces(0),
                       dummy(0), success(false) {}
    };
    
    MemoryInfo GetMemoryInfo();

private:
    // Socket management
    bool CreateSocket();
    void CloseSocket();
    
    // Protocol implementation
    std::vector<uint8_t> CreateHeader(uint16_t command, const std::vector<uint8_t>& commandString, 
                                     uint16_t sessionId, uint16_t replyId);
    uint16_t CreateChecksum(const std::vector<uint8_t>& packet);
    std::vector<uint8_t> CreateTcpTop(const std::vector<uint8_t>& packet);
    bool SendCommand(uint16_t command, const std::vector<uint8_t>& commandString = std::vector<uint8_t>{},
                     int responseSize = 8, std::vector<uint8_t>* response = nullptr, const std::string& caller = "");
    void SendAckOnly(const std::vector<uint8_t>& receivedHeader = std::vector<uint8_t>());
    
    // Data parsing
    std::vector<uint8_t> MakeCommKey(int password, int sessionId, int ticks = 50);
    std::string DecodeTime(const std::vector<uint8_t>& timeBytes);
    std::vector<uint8_t> EncodeTime(const std::string& timestamp);
    
    // TCP data handling
    std::pair<std::vector<uint8_t>, std::vector<uint8_t>> ReceiveTcpData(const std::vector<uint8_t>& dataRecv, int size);
    std::vector<uint8_t> ReceiveRawData(int size);
    int TestTcpTop(const std::vector<uint8_t>& data);
    
    // Chunk handling
    std::vector<uint8_t> ReceiveChunk();
    std::vector<uint8_t> ReadChunk(int start, int size);
    std::pair<std::vector<uint8_t>, int> ReadWithBuffer(uint8_t command, int fct = 0, int ext = 0);
    void FreeData();
    
    // Live capture helpers
    ZKTecoAttendance ParseLiveEventData(const std::vector<uint8_t>& data);
    void ProcessEventBuffer();
    void FlushExistingEvents();

    // Member variables
    std::string address_;
    int port_;
    int timeout_;
    int password_;
    bool forceUdp_;
    bool verbose_;
    
    SOCKET socket_;
    bool isConnected_;
    uint16_t sessionId_;
    uint16_t replyId_;
    
    // Last response data (for __get_data_size functionality)
    uint16_t lastResponse_;
    std::vector<uint8_t> lastData_;
    int tcpLength_;
    
    // Device capacity
    int users_;
    int fingers_;
    int records_;
    int usersCapacity_;
    int fingersCapacity_;
    int recordsCapacity_;
    
    // User management
    int nextUid_;
    std::string nextUserId_;
    int userPacketSize_;
    std::string encoding_;
    
    // Live capture state
    bool liveCaptureActive_;
    bool wasEnabledBeforeLiveCapture_;
    std::vector<ZKTecoUser> liveCaptureUsers_;
    int liveCaptureTimeout_;
    std::vector<uint8_t> liveEventBuffer_; // Buffer for unprocessed event data
    std::queue<ZKTecoAttendance> eventQueue_; // Queue of parsed events
};
