#include "zkteco_device.h"
#include "objects/zkteco_user.h"
#include "objects/zkteco_const.h"
#include "objects/zkteco_finger.h"
#include "objects/zkteco_attendance.h"
#include "objects/zkteco_device_info.h"
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <chrono>
#include <thread>
#include <iomanip>
#include <algorithm>
#include <ctime>
#include <cstring>

using namespace ZKTecoConstants;

ZKTecoDevice::ZKTecoDevice(const std::string& address, int port, int timeout, 
                           int password, bool forceUdp, bool verbose)
    : address_(address), port_(port), timeout_(timeout), password_(password),
      forceUdp_(forceUdp), verbose_(verbose), socket_(INVALID_SOCKET),
      isConnected_(false), sessionId_(0), replyId_(65534), // USHRT_MAX - 1
      lastResponse_(0), lastData_(), tcpLength_(0),
      users_(0), fingers_(0), records_(0), usersCapacity_(0), 
      fingersCapacity_(0), recordsCapacity_(0),
      nextUid_(1), nextUserId_("1"), userPacketSize_(0), encoding_("UTF-8"),
      liveCaptureActive_(false), wasEnabledBeforeLiveCapture_(false), 
      liveCaptureUsers_(), liveCaptureTimeout_(10),
      liveEventBuffer_(), eventQueue_() {
    
    // Initialize Winsock
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        throw std::runtime_error("Failed to initialize Winsock");
    }
}

ZKTecoDevice::~ZKTecoDevice() {
    if (isConnected_) {
        Disconnect();
    }
    WSACleanup();
}

bool ZKTecoDevice::Connect() {
    try {
        if (!CreateSocket()) {
            return false;
        }

        // Reset session state
        sessionId_ = 0;
        replyId_ = 65534; // USHRT_MAX - 1

        // Send connect command
        std::vector<uint8_t> response;
        if (verbose_) std::cout << "Sending connect command..." << std::endl;
        if (!SendCommand(ZKTecoConstants::CMD_CONNECT, std::vector<uint8_t>{}, 1024, &response, "Connect")) {
            if (verbose_) std::cout << "Failed to send connect command" << std::endl;
            CloseSocket();
            return false;
        }

        if (verbose_) std::cout << "Connect response size: " << response.size() << std::endl;

        // Extract session ID from response header
        if (response.size() >= 8) {
            sessionId_ = (response[5] << 8) | response[4]; // Little endian
            if (verbose_) {
                std::cout << "Session ID: " << sessionId_ << std::endl;
            }
        } else {
            if (verbose_) std::cout << "Response too small to extract session ID" << std::endl;
            CloseSocket();
            return false;
        }

        // Check if authentication is required
        uint16_t responseCode = (response[1] << 8) | response[0];
        if (verbose_) std::cout << "Initial response code: " << responseCode << " (Expected: " << ZKTecoConstants::CMD_ACK_OK << " or " << ZKTecoConstants::CMD_ACK_UNAUTH << ")" << std::endl;
        
        if (responseCode == ZKTecoConstants::CMD_ACK_UNAUTH) {
            if (verbose_) std::cout << "Authentication required, using password: " << password_ << std::endl;
            
            auto commKey = MakeCommKey(password_, sessionId_);
            if (verbose_) {
                std::cout << "Generated auth key size: " << commKey.size() << " bytes: ";
                for (auto byte : commKey) {
                    std::cout << std::hex << (int)byte << " ";
                }
                std::cout << std::dec << std::endl;
            }
            
            if (verbose_) std::cout << "Sending authentication command..." << std::endl;
            if (!SendCommand(ZKTecoConstants::CMD_AUTH, commKey, 1024, &response, "Auth")) {
                if (verbose_) std::cout << "Failed to send auth command" << std::endl;
                CloseSocket();
                return false;
            }
            
            if (verbose_) std::cout << "Auth command sent, response size: " << response.size() << std::endl;
            
            // Check authentication response
            if (response.size() >= 2) {
                uint16_t authResponseCode = (response[1] << 8) | response[0];
                if (verbose_) std::cout << "Auth response code: " << authResponseCode << " (Expected: " << ZKTecoConstants::CMD_ACK_OK << ")" << std::endl;
                
                if (authResponseCode != ZKTecoConstants::CMD_ACK_OK) {
                    if (verbose_) std::cout << "Authentication failed with code: " << authResponseCode << std::endl;
                    if (authResponseCode == ZKTecoConstants::CMD_ACK_UNAUTH) {
                        if (verbose_) std::cout << "Still unauthorized - incorrect password" << std::endl;
                    } else if (authResponseCode == ZKTecoConstants::CMD_ACK_ERROR) {
                        if (verbose_) std::cout << "Authentication error" << std::endl;
                    }
                    CloseSocket();
                    return false;
                }
                if (verbose_) std::cout << "Authentication successful!" << std::endl;
            } else {
                if (verbose_) std::cout << "Invalid auth response size: " << response.size() << std::endl;
                CloseSocket();
                return false;
            }
        } else if (responseCode == ZKTecoConstants::CMD_ACK_OK) {
            if (verbose_) std::cout << "No authentication required - direct connection successful" << std::endl;
        } else {
            if (verbose_) std::cout << "Connection failed with response code: " << responseCode << std::endl;
            if (responseCode == ZKTecoConstants::CMD_ACK_ERROR) {
                if (verbose_) std::cout << "General error from device" << std::endl;
            } else if (responseCode == ZKTecoConstants::CMD_ACK_UNKNOWN) {
                if (verbose_) std::cout << "Unknown command error" << std::endl;
            }
            CloseSocket();
            return false;
        }

        isConnected_ = true;
        if (verbose_) std::cout << "Connection established successfully" << std::endl;
        return true;
    } catch (const std::exception& e) {
        if (verbose_) std::cout << "Connection failed: " << e.what() << std::endl;
        CloseSocket();
        return false;
    }
}

bool ZKTecoDevice::Disconnect() {
    if (!isConnected_) return true;
    
    try {
        SendCommand(CMD_EXIT, std::vector<uint8_t>{}, 8, nullptr, "Disconnect");
        CloseSocket();
        isConnected_ = false;
        return true;
    } catch (const std::exception& e) {
        if (verbose_) std::cout << "Disconnect error: " << e.what() << std::endl;
        CloseSocket();
        isConnected_ = false;
        return false;
    }
}

bool ZKTecoDevice::CreateSocket() {
    if (!forceUdp_) {
        // Try TCP first
        socket_ = socket(AF_INET, SOCK_STREAM, 0);
        if (socket_ == INVALID_SOCKET) {
            return false;
        }

        // Set timeout
        DWORD timeout = timeout_ * 1000; // Convert to milliseconds
        setsockopt(socket_, SOL_SOCKET, SO_RCVTIMEO, (const char*)&timeout, sizeof(timeout));
        setsockopt(socket_, SOL_SOCKET, SO_SNDTIMEO, (const char*)&timeout, sizeof(timeout));

        sockaddr_in serverAddr = {};
        serverAddr.sin_family = AF_INET;
        serverAddr.sin_port = htons(static_cast<u_short>(port_));
        inet_pton(AF_INET, address_.c_str(), &serverAddr.sin_addr);

        if (connect(socket_, (sockaddr*)&serverAddr, sizeof(serverAddr)) != SOCKET_ERROR) {
            return true; // TCP connection successful
        }
        
        CloseSocket();
    }

    // Fall back to UDP or force UDP
    socket_ = socket(AF_INET, SOCK_DGRAM, 0);
    if (socket_ == INVALID_SOCKET) {
        return false;
    }

    // Set timeout for UDP
    DWORD timeout = timeout_ * 1000;
    setsockopt(socket_, SOL_SOCKET, SO_RCVTIMEO, (const char*)&timeout, sizeof(timeout));
    setsockopt(socket_, SOL_SOCKET, SO_SNDTIMEO, (const char*)&timeout, sizeof(timeout));

    return true;
}

void ZKTecoDevice::CloseSocket() {
    if (socket_ != INVALID_SOCKET) {
        closesocket(socket_);
        socket_ = INVALID_SOCKET;
    }
}

std::vector<uint8_t> ZKTecoDevice::CreateHeader(uint16_t command, const std::vector<uint8_t>& commandString, 
                                               uint16_t sessionId, uint16_t replyId) {
    // Create basic header: command(2) + checksum(2) + sessionId(2) + replyId(2) + data
    std::vector<uint8_t> header(8);
    
    // Command (little endian)
    header[0] = command & 0xFF;
    header[1] = (command >> 8) & 0xFF;
    
    // Placeholder for checksum (will be calculated later)
    header[2] = 0;
    header[3] = 0;
    
    // Session ID (little endian)
    header[4] = sessionId & 0xFF;
    header[5] = (sessionId >> 8) & 0xFF;
    
    // Reply ID (little endian)
    header[6] = replyId & 0xFF;
    header[7] = (replyId >> 8) & 0xFF;
    
    // Append command string
    header.insert(header.end(), commandString.begin(), commandString.end());
    
    // Calculate and set checksum
    uint16_t checksum = CreateChecksum(header);
    header[2] = checksum & 0xFF;
    header[3] = (checksum >> 8) & 0xFF;
    
    return header;
}

uint16_t ZKTecoDevice::CreateChecksum(const std::vector<uint8_t>& packet) {
    // Implementation based on pyzk checksum algorithm
    uint32_t checksum = 0;
    size_t len = packet.size();
    
    for (size_t i = 0; i < len; i += 2) {
        if (i + 1 < len) {
            checksum += (packet[i+1] << 8) | packet[i];
        } else {
            checksum += packet[i];
        }
        
        if (checksum > 65535) {
            checksum -= 65535;
        }
    }
    
    checksum = (~checksum) & 0xFFFF;
    
    return static_cast<uint16_t>(checksum);
}

std::vector<uint8_t> ZKTecoDevice::CreateTcpTop(const std::vector<uint8_t>& packet) {
    std::vector<uint8_t> tcpPacket(8);
    uint32_t length = static_cast<uint32_t>(packet.size());
    
    // TCP header: MACHINE_PREPARE_DATA_1(2) + MACHINE_PREPARE_DATA_2(2) + length(4)
    tcpPacket[0] = ZKTecoConstants::MACHINE_PREPARE_DATA_1 & 0xFF;
    tcpPacket[1] = (ZKTecoConstants::MACHINE_PREPARE_DATA_1 >> 8) & 0xFF;
    tcpPacket[2] = ZKTecoConstants::MACHINE_PREPARE_DATA_2 & 0xFF;
    tcpPacket[3] = (ZKTecoConstants::MACHINE_PREPARE_DATA_2 >> 8) & 0xFF;
    tcpPacket[4] = length & 0xFF;
    tcpPacket[5] = (length >> 8) & 0xFF;
    tcpPacket[6] = (length >> 16) & 0xFF;
    tcpPacket[7] = (length >> 24) & 0xFF;
    
    // Append the actual packet
    tcpPacket.insert(tcpPacket.end(), packet.begin(), packet.end());
    
    return tcpPacket;
}

bool ZKTecoDevice::SendCommand(uint16_t command, const std::vector<uint8_t>& commandString,
                               int responseSize, std::vector<uint8_t>* response, const std::string& caller) {
    if (!isConnected_ && command != ZKTecoConstants::CMD_CONNECT && command != ZKTecoConstants::CMD_AUTH) {
        throw std::runtime_error("Device not connected");
    }

    // Increment reply ID
    replyId_++;
    if (replyId_ >= 65535) {
        replyId_ = 0;
    }

    // Create packet
    auto packet = CreateHeader(command, commandString, sessionId_, replyId_);
    
    try {
        bool isTcp = (socket_ != INVALID_SOCKET);
        
        if (isTcp && !forceUdp_) {
            // TCP communication
            auto tcpPacket = CreateTcpTop(packet);
            
            int sent = send(socket_, (const char*)tcpPacket.data(), static_cast<int>(tcpPacket.size()), 0);
            if (sent == SOCKET_ERROR) {
                throw std::runtime_error("Failed to send TCP packet");
            }
            
            // Receive response - Python receives responseSize + 8 bytes
            std::vector<uint8_t> buffer(responseSize + 8);
            int received = recv(socket_, (char*)buffer.data(), static_cast<int>(buffer.size()), 0);
            if (received == SOCKET_ERROR) {
                if (verbose_) std::cout << "TCP receive error, WSA: " << WSAGetLastError() << std::endl;
                throw std::runtime_error("Failed to receive TCP response");
            }
            
            
            // Validate TCP header following Python __test_tcp_top logic
            if (received >= 16) { // Need at least 8 bytes TCP header + 8 bytes command header
                // TCP header format: MACHINE_PREPARE_DATA_1(2) + MACHINE_PREPARE_DATA_2(2) + length(4)
                uint16_t header1 = buffer[0] | (buffer[1] << 8);
                uint16_t header2 = buffer[2] | (buffer[3] << 8);
                
                if (header1 == ZKTecoConstants::MACHINE_PREPARE_DATA_1 && header2 == ZKTecoConstants::MACHINE_PREPARE_DATA_2) {
                    // Valid TCP headers - extract response starting from byte 8
                    // This matches Python's self.__data_recv = self.__tcp_data_recv[8:]
                    if (response) {
                        response->assign(buffer.begin() + 8, buffer.begin() + received);
                    }
                } else {
                    // Don't throw error - just return false to match Python behavior
                    return false;
                }
            } else {
                // Don't throw error - just return false to match Python behavior
                return false;
            }
        } else {
            // UDP communication
            sockaddr_in serverAddr = {};
            serverAddr.sin_family = AF_INET;
            serverAddr.sin_port = htons(static_cast<u_short>(port_));
            inet_pton(AF_INET, address_.c_str(), &serverAddr.sin_addr);
            
            int sent = sendto(socket_, (const char*)packet.data(), static_cast<int>(packet.size()), 0,
                             (sockaddr*)&serverAddr, sizeof(serverAddr));
            if (sent == SOCKET_ERROR) {
                throw std::runtime_error("Failed to send UDP packet");
            }
            
            // Receive response
            std::vector<uint8_t> buffer(responseSize);
            int addrLen = sizeof(serverAddr);
            int received = recvfrom(socket_, (char*)buffer.data(), static_cast<int>(buffer.size()), 0,
                                   (sockaddr*)&serverAddr, &addrLen);
            if (received == SOCKET_ERROR) {
                throw std::runtime_error("Failed to receive UDP response");
            }
            
            
            if (response) {
                response->assign(buffer.begin(), buffer.begin() + received);
                if (verbose_) std::cout << "UDP response size: " << response->size() << std::endl;
            }
        }
        
        //Print the response here
        //if (response && verbose_) {
        //    std::cout << caller << " response: ";
        //    for (size_t i = 0; i < response->size(); ++i) {
        //        std::cout << std::hex << (int)(*response)[i] << " ";
        //    }
        //    std::cout << std::dec << std::endl;
        //}
        
        // Store last response and data for GetDataSize functionality
        if (response && response->size() >= 2) {
            lastResponse_ = (*response)[0] | ((*response)[1] << 8); // Little endian
            if (response->size() > 8) {
                // Store data portion (skip 8-byte header)
                lastData_.assign(response->begin() + 8, response->end());
            } else {
                lastData_.clear();
            }
            
            // Store TCP length if using TCP
            if (!forceUdp_ && socket_ != INVALID_SOCKET) {
                // For TCP, we need to track the original TCP packet length
                // This would be set from the TCP header when we first receive data
                tcpLength_ = TestTcpTop(*response);
            }
        } else {
            lastResponse_ = 0;
            lastData_.clear();
            tcpLength_ = 0;
        }
        
        return true;
    } catch (const std::exception& e) {
        if (verbose_) std::cout << "Send command error: " << e.what() << std::endl;
        if (verbose_) std::cout << "WSA Error code: " << WSAGetLastError() << std::endl;
        return false;
    }
}

void ZKTecoDevice::SendAckOnly(const std::vector<uint8_t>& receivedHeader) {
    try {
        // Extract session ID and reply ID from received header if available
        uint16_t ackSessionId = sessionId_; // Default to connection session ID
        uint16_t ackReplyId = 65534; // Default to USHRT_MAX - 1
        
        if (receivedHeader.size() >= 8) {
            // Extract from received header: [command(2), checksum(2), session_id(2), reply_id(2)]
            ackSessionId = receivedHeader[4] | (receivedHeader[5] << 8);
            ackReplyId = receivedHeader[6] | (receivedHeader[7] << 8);
            
            if (verbose_) {
                std::cout << "Using received packet IDs: sessionId=0x" << std::hex << ackSessionId 
                         << ", replyId=0x" << ackReplyId << std::dec << std::endl;
            }
        } else {
            if (verbose_) {
                std::cout << "Using default connection IDs: sessionId=0x" << std::hex << ackSessionId 
                         << ", replyId=0x" << ackReplyId << std::dec << std::endl;
            }
        }
        
        // Create ACK packet (based on Python __ack_ok implementation)
        std::vector<uint8_t> ackData; // Empty command string
        std::vector<uint8_t> packet = CreateHeader(ZKTecoConstants::CMD_ACK_OK, ackData, ackSessionId, ackReplyId);
        
        if (!forceUdp_) {
            // TCP: Add TCP top header
            std::vector<uint8_t> tcpPacket = CreateTcpTop(packet);
            if (verbose_) {
                std::cout << "Sending ACK (TCP, " << tcpPacket.size() << " bytes)" << std::endl;
            }
            send(socket_, reinterpret_cast<const char*>(tcpPacket.data()), static_cast<int>(tcpPacket.size()), 0);
        } else {
            // UDP: Send directly
            if (verbose_) {
                std::cout << "Sending ACK (UDP, " << packet.size() << " bytes)" << std::endl;
            }
            send(socket_, reinterpret_cast<const char*>(packet.data()), static_cast<int>(packet.size()), 0);
        }
    } catch (const std::exception& e) {
        if (verbose_) std::cout << "Send ACK error: " << e.what() << std::endl;
    }
}

std::vector<uint8_t> ZKTecoDevice::MakeCommKey(int password, int sessionId, int ticks) {
    // Implementation of the key scrambling algorithm from pyzk
    if (verbose_) std::cout << "MakeCommKey: password=" << password << ", sessionId=" << sessionId << ", ticks=" << ticks << std::endl;
    
    uint32_t key = static_cast<uint32_t>(password);
    uint32_t session = static_cast<uint32_t>(sessionId);
    
    uint32_t k = 0;
    for (int i = 0; i < 32; i++) {
        if (key & (1 << i)) {
            k = (k << 1) | 1;
        } else {
            k = k << 1;
        }
    }
    if (verbose_) std::cout << "Key after bit manipulation: " << k << std::endl;
    
    k += session;
    if (verbose_) std::cout << "Key after adding session: " << k << std::endl;
    
    // Convert to bytes and XOR with 'ZKSO'
    std::vector<uint8_t> result(4);
    result[0] = (k & 0xFF) ^ 'Z';
    result[1] = ((k >> 8) & 0xFF) ^ 'K';
    result[2] = ((k >> 16) & 0xFF) ^ 'S';
    result[3] = ((k >> 24) & 0xFF) ^ 'O';
    
    if (verbose_) {
        std::cout << "After ZKSO XOR: ";
        for (auto byte : result) {
            std::cout << std::hex << (int)byte << " ";
        }
        std::cout << std::dec << std::endl;
    }
    
    // Swap bytes and XOR with ticks
    uint8_t b = ticks & 0xFF;
    std::swap(result[0], result[2]);
    std::swap(result[1], result[3]);
    result[0] ^= b;
    result[1] ^= b;
    result[2] = b;        // Set directly to b, not XOR
    result[3] ^= b;
    
    if (verbose_) {
        std::cout << "Final auth key: ";
        for (auto byte : result) {
            std::cout << std::hex << (int)byte << " ";
        }
        std::cout << std::dec << std::endl;
    }
    
    return result;
}

// TCP data handling methods
std::pair<std::vector<uint8_t>, std::vector<uint8_t>> ZKTecoDevice::ReceiveTcpData(const std::vector<uint8_t>& dataRecv, int size) {
    std::vector<uint8_t> data;
    std::vector<uint8_t> broken;
    
    int tcpLength = TestTcpTop(dataRecv);
    if (verbose_) std::cout << "tcp_length " << tcpLength << ", size " << size << std::endl;
    
    if (tcpLength <= 0) {
        if (verbose_) std::cout << "Incorrect tcp packet" << std::endl;
        return std::make_pair(std::vector<uint8_t>(), std::vector<uint8_t>());
    }
    
    if ((tcpLength - 8) < size) {
        if (verbose_) std::cout << "tcp length too small... retrying" << std::endl;
        
        // Recursive call to get first part
        auto [resp1, bh] = ReceiveTcpData(dataRecv, tcpLength - 8);
        data.insert(data.end(), resp1.begin(), resp1.end());
        size -= static_cast<int>(resp1.size());
        
        if (verbose_) std::cout << "new tcp DATA packet to fill missing " << size << std::endl;
        
        // Receive more data
        std::vector<uint8_t> newDataRecv = bh;
        std::vector<uint8_t> additionalData = ReceiveRawData(size + 16);
        newDataRecv.insert(newDataRecv.end(), additionalData.begin(), additionalData.end());
        
        if (verbose_) std::cout << "new tcp DATA starting with " << newDataRecv.size() << " bytes" << std::endl;
        
        // Recursive call to get second part
        auto [resp2, bh2] = ReceiveTcpData(newDataRecv, size);
        data.insert(data.end(), resp2.begin(), resp2.end());
        
        if (verbose_) std::cout << "for missing " << size << " received " << resp2.size() << " with extra " << bh2.size() << std::endl;
        
        return std::make_pair(data, bh2);
    }
    
    int received = static_cast<int>(dataRecv.size());
    if (verbose_) std::cout << "received " << received << ", size " << size << std::endl;
    
    // Extract response code from header (bytes 8-16)
    if (dataRecv.size() < 16) {
        if (verbose_) std::cout << "Data too small to extract response code" << std::endl;
        return std::make_pair(std::vector<uint8_t>(), std::vector<uint8_t>());
    }
    
    uint16_t response = dataRecv[8] | (dataRecv[9] << 8); // Little endian
    
    if (received >= (size + 32)) {
        if (response == ZKTecoConstants::CMD_DATA) {
            // Extract response data (bytes 16 to size+16)
            if (dataRecv.size() >= size + 16) {
                std::vector<uint8_t> resp(dataRecv.begin() + 16, dataRecv.begin() + size + 16);
                if (verbose_) std::cout << "resp complete len " << resp.size() << std::endl;
                
                // Return remaining data as broken header
                std::vector<uint8_t> remainingData(dataRecv.begin() + size + 16, dataRecv.end());
                return std::make_pair(resp, remainingData);
            }
        } else {
            if (verbose_) std::cout << "incorrect response!!! " << response << std::endl;
            return std::make_pair(std::vector<uint8_t>(), std::vector<uint8_t>());
        }
    } else {
        if (verbose_) std::cout << "try DATA incomplete (actual valid " << (received - 16) << ")" << std::endl;
        
        // Extract available data
        int availableData = received - 16;
        if (availableData > 0 && dataRecv.size() >= 16) {
            int dataToExtract = std::min(availableData, size);
            std::vector<uint8_t> partialData(dataRecv.begin() + 16, dataRecv.begin() + 16 + dataToExtract);
            data.insert(data.end(), partialData.begin(), partialData.end());
            size -= dataToExtract;
        }
        
        std::vector<uint8_t> brokenHeader;
        if (size < 0) {
            // Handle broken header case
            int brokenStart = static_cast<int>(dataRecv.size()) + size;
            if (brokenStart < dataRecv.size()) {
                brokenHeader = std::vector<uint8_t>(dataRecv.begin() + brokenStart, dataRecv.end());
                if (verbose_) {
                    std::cout << "broken header: ";
                    for (auto byte : brokenHeader) {
                        std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte) << " ";
                    }
                    std::cout << std::dec << std::endl;
                }
            }
        }
        
        if (size > 0) {
            std::vector<uint8_t> additionalData = ReceiveRawData(size);
            data.insert(data.end(), additionalData.begin(), additionalData.end());
        }
        
        return std::make_pair(data, brokenHeader);
    }
    
    return std::make_pair(std::vector<uint8_t>(), std::vector<uint8_t>());
}

std::vector<uint8_t> ZKTecoDevice::ReceiveRawData(int size) {
    std::vector<uint8_t> data;
    if (verbose_) std::cout << "expecting " << size << " bytes raw data" << std::endl;
    
    while (size > 0) {
        std::vector<uint8_t> buffer(size);
        int received = recv(socket_, (char*)buffer.data(), size, 0);
        
        if (received == SOCKET_ERROR) {
            if (verbose_) std::cout << "Error receiving raw data: " << WSAGetLastError() << std::endl;
            break;
        }
        
        if (received == 0) {
            if (verbose_) std::cout << "Connection closed by remote host" << std::endl;
            break;
        }
        
        if (verbose_) std::cout << "partial recv " << received << std::endl;
        
        if (received < 100 && verbose_) {
            std::cout << "   recv ";
            for (int i = 0; i < received; i++) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(buffer[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
        
        // Add received data to our collection
        data.insert(data.end(), buffer.begin(), buffer.begin() + received);
        size -= received;
        
        if (verbose_) std::cout << "still need " << size << std::endl;
    }
    
    return data;
}

int ZKTecoDevice::TestTcpTop(const std::vector<uint8_t>& data) {
    // Python: if len(packet)<=8: return 0
    if (data.size() <= 8) {
        return 0;
    }
    
    // Python: tcp_header = unpack('<HHI', packet[:8])
    // Extract little-endian: H = uint16, H = uint16, I = uint32
    uint16_t header1 = data[0] | (data[1] << 8);
    uint16_t header2 = data[2] | (data[3] << 8);
    uint32_t length = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
    
    // Python: if tcp_header[0] == const.MACHINE_PREPARE_DATA_1 and tcp_header[1] == const.MACHINE_PREPARE_DATA_2:
    //         return tcp_header[2]
    if (header1 == ZKTecoConstants::MACHINE_PREPARE_DATA_1 && 
        header2 == ZKTecoConstants::MACHINE_PREPARE_DATA_2) {
        return static_cast<int>(length);
    }
    
    // Python: return 0
    return 0;
}

// Device information methods
ZKTecoDeviceInfo ZKTecoDevice::GetDeviceInfo() {
    ZKTecoDeviceInfo info;

    info.SetFirmwareVersion(GetFirmwareVersion());
    info.SetSerialNumber(GetSerialNumber());
    info.SetPlatform(GetPlatform());
    info.SetDeviceName(GetDeviceName());
    info.SetMacAddress(GetMacAddress());
    info.SetDeviceTime(GetDeviceTime());
    info.SetFaceVersion(GetFaceVersion());
    info.SetFpVersion(GetFpVersion());
    
    return info;
}

std::string ZKTecoDevice::GetFirmwareVersion() {
    if (!isConnected_) return "";
    
    std::vector<uint8_t> response;
    if (SendCommand(CMD_GET_VERSION, std::vector<uint8_t>{}, 1024, &response, "GetFirmwareVersion")) {
        if (response.size() > 8) {
            // Extract firmware version string (skip 8-byte header)
            std::string version;
            for (size_t i = 8; i < response.size() && response[i] != 0; i++) {
                version += static_cast<char>(response[i]);
            }
            return version;
        }
    }
    return "";
}

std::string ZKTecoDevice::GetSerialNumber() {
    if (!isConnected_) return "";
    
    std::string query = "~SerialNumber";
    query.push_back('\0');
    std::vector<uint8_t> cmdString(query.begin(), query.end());
    
    std::vector<uint8_t> response;
    if (SendCommand(CMD_OPTIONS_RRQ, cmdString, 1024, &response, "GetSerialNumber")) {
        if (response.size() > 8) {
            std::string data(response.begin() + 8, response.end());
            size_t pos = data.find('=');
            if (pos != std::string::npos) {
                std::string serial = data.substr(pos + 1);
                serial.erase(serial.find('\0')); // Remove null terminator
                return serial;
            }
        }
    }
    return "";
}

std::string ZKTecoDevice::GetPlatform() {
    if (!isConnected_) return "";
    
    std::string query = "~Platform";
    query.push_back('\0');
    std::vector<uint8_t> cmdString(query.begin(), query.end());
    
    std::vector<uint8_t> response;
    if (SendCommand(CMD_OPTIONS_RRQ, cmdString, 1024, &response, "GetPlatform")) {
        if (response.size() > 8) {
            std::string data(response.begin() + 8, response.end());
            size_t pos = data.find('=');
            if (pos != std::string::npos) {
                std::string platform = data.substr(pos + 1);
                platform.erase(platform.find('\0'));
                return platform;
            }
        }
    }
    return "";
}

std::string ZKTecoDevice::GetDeviceName() {
    if (!isConnected_) return "";
    
    std::string query = "~DeviceName";
    query.push_back('\0');
    std::vector<uint8_t> cmdString(query.begin(), query.end());
    
    std::vector<uint8_t> response;
    if (SendCommand(CMD_OPTIONS_RRQ, cmdString, 1024, &response, "GetDeviceName")) {
        //std::cout << response << std::endl;
        if (response.size() > 8) {
            std::string data(response.begin() + 8, response.end());
            size_t pos = data.find('=');
            if (pos != std::string::npos) {
                std::string deviceName = data.substr(pos + 1);
                deviceName.erase(deviceName.find('\0'));
                return deviceName;
            }
        }
    }
    return "";
}

std::string ZKTecoDevice::GetMacAddress() {
    if (!isConnected_) return "";
    
    std::string query = "MAC";
    query.push_back('\0');
    std::vector<uint8_t> cmdString(query.begin(), query.end());
    
    std::vector<uint8_t> response;
    if (SendCommand(CMD_OPTIONS_RRQ, cmdString, 1024, &response, "GetMacAddress")) {
        if (response.size() > 8) {
            std::string data(response.begin() + 8, response.end());
            size_t pos = data.find('=');
            if (pos != std::string::npos) {
                std::string mac = data.substr(pos + 1);
                mac.erase(mac.find('\0'));
                return mac;
            }
        }
    }
    return "";
}

std::string ZKTecoDevice::GetFaceVersion() {
    if (!isConnected_) return "";

    std::string query = "ZKFaceVersion";
    query.push_back('\0');
    std::vector<uint8_t> cmdString(query.begin(), query.end());

    std::vector<uint8_t> response;
    if (SendCommand(CMD_OPTIONS_RRQ, cmdString, 1024, &response, "GetFaceVersion")) {
        if (response.size() > 8) {
            std::string data(response.begin() + 8, response.end());
            
            size_t pos = data.find('=');
            if (pos != std::string::npos) {
                std::string faceVersionStr = data.substr(pos + 1);
                
                size_t nullPos = faceVersionStr.find('\0');
                if (nullPos != std::string::npos) {
                    faceVersionStr.erase(nullPos);
                }
                
                return faceVersionStr;
            }
        }
    }
    return "0";
}

std::string ZKTecoDevice::GetFpVersion() {
    if (!isConnected_) return "";

    std::string query = "~ZKFPVersion";
    query.push_back('\0');
    std::vector<uint8_t> cmdString(query.begin(), query.end());

    std::vector<uint8_t> response;
    if (SendCommand(CMD_OPTIONS_RRQ, cmdString, 1024, &response, "GetFpVersion")) {
        if (response.size() > 8) {
            std::string data(response.begin() + 8, response.end());
            
            size_t pos = data.find('=');
            if (pos != std::string::npos) {
                std::string fpVersionStr = data.substr(pos + 1);
                
                size_t nullPos = fpVersionStr.find('\0');
                if (nullPos != std::string::npos) {
                    fpVersionStr.erase(nullPos);
                }
                
                return fpVersionStr;
            }
        }
    }
    return "0";
}

std::string ZKTecoDevice::GetDeviceTime() {
    if (!isConnected_) return "";
    
    std::vector<uint8_t> response;
    if (SendCommand(CMD_GET_TIME, std::vector<uint8_t>{}, 1024, &response, "GetDeviceTime")) {
        if (response.size() >= 12) { // 8 header + 4 time bytes
            std::vector<uint8_t> timeBytes(response.begin() + 8, response.begin() + 12);
            return DecodeTime(timeBytes);
        }
    }
    return "";
}

ZKTecoDevice::MemoryInfo ZKTecoDevice::GetMemoryInfo() {
    MemoryInfo memInfo;
    std::ostringstream debug;
    
    if (!isConnected_) {
        debug << "Device not connected; ";
        memInfo.debugInfo = debug.str();
        return memInfo; // success = false by default
    }
    
    try {
        debug << "Sending CMD_GET_FREE_SIZES command (sessionId: " << sessionId_ << ", replyId: " << replyId_ << ")...; ";
        
        // Send CMD_GET_FREE_SIZES command (constant 50 from pyzk)
        std::vector<uint8_t> response;
        if (!SendCommand(CMD_GET_FREE_SIZES, std::vector<uint8_t>{}, 1024, &response, "GetMemoryInfo")) {
            debug << "Failed to send CMD_GET_FREE_SIZES command; ";
            memInfo.debugInfo = debug.str();
            return memInfo;
        }

        debug << "Response size: " << response.size() << "; ";

        if (response.size() < 8) {
            debug << "Response too small (no header); ";
            memInfo.debugInfo = debug.str();
            return memInfo;
        }

        // Check response code (first 2 bytes, little-endian)
        uint16_t responseCode = response[0] | (response[1] << 8);
        debug << "Response code: " << responseCode << "; ";
        
        // Check if response is successful (based on Python's success criteria)
        if (responseCode != CMD_ACK_OK && 
            responseCode != CMD_ACK_DATA && 
            responseCode != CMD_PREPARE_DATA) {
            debug << "Response code indicates failure: " << responseCode << "; ";
            debug << "Expected codes: " << CMD_ACK_OK << " or " << CMD_ACK_DATA << "; ";
            memInfo.debugInfo = debug.str();
            return memInfo;
        }

        // Extract data portion (skip 8-byte header like Python does)
        const uint8_t* data = response.data() + 8;
        size_t dataSize = response.size() - 8;
        
        debug << "Data size after header: " << dataSize << "; ";

        if (dataSize < 80) { // Need at least 80 bytes for 20 integers
            debug << "Insufficient data size: " << dataSize << "; ";
            memInfo.debugInfo = debug.str();
            return memInfo;
        }

        // Manual little-endian unpacking to match Python's unpack('20i', ...)
        auto readLittleEndianInt32 = [](const uint8_t* bytes) -> int32_t {
            return static_cast<int32_t>(
                bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
            );
        };

        // Extract 20 integers (80 bytes) in little-endian format
        std::vector<int32_t> fields(20);
        for (int i = 0; i < 20; i++) {
            fields[i] = readLittleEndianInt32(data + i * 4);
        }
        debug << "Parsed 20 fields; ";

        // Extract memory information based on pyzk field indices
        memInfo.usedUsers = fields[4];           // self.users = fields[4]
        memInfo.usedFingers = fields[6];         // self.fingers = fields[6]
        memInfo.usedRecords = fields[8];         // self.records = fields[8]
        memInfo.dummy = fields[10];              // self.dummy = fields[10]
        memInfo.usedCards = fields[12];          // self.cards = fields[12]
        memInfo.totalFingers = fields[14];       // self.fingers_cap = fields[14]
        memInfo.totalUsers = fields[15];         // self.users_cap = fields[15]
        memInfo.totalRecords = fields[16];       // self.rec_cap = fields[16]
        memInfo.availableFingers = fields[17];   // self.fingers_av = fields[17]
        memInfo.availableUsers = fields[18];     // self.users_av = fields[18]
        memInfo.availableRecords = fields[19];   // self.rec_av = fields[19]

        debug << "Users: " << memInfo.usedUsers << "/" << memInfo.totalUsers << "; ";
        debug << "Fingers: " << memInfo.usedFingers << "/" << memInfo.totalFingers << "; ";
        debug << "Records: " << memInfo.usedRecords << "/" << memInfo.totalRecords << "; ";

        // Check if there's face data (additional 12+ bytes after the first 80)
        if (dataSize >= 92) { // 80 basic + 12 face data
            debug << "Face data available, parsing...; ";
            
            // Read 3 more integers for face data
            memInfo.usedFaces = readLittleEndianInt32(data + 80);     // fields[0] from remaining data
            // Skip fields[1] - not used according to pyzk implementation
            memInfo.totalFaces = readLittleEndianInt32(data + 88);    // fields[2] from remaining data
            memInfo.availableFaces = memInfo.totalFaces - memInfo.usedFaces;
            
            debug << "Faces: " << memInfo.usedFaces << "/" << memInfo.totalFaces << "; ";
        } else {
            // No face data available
            memInfo.usedFaces = 0;
            memInfo.totalFaces = 0;
            memInfo.availableFaces = 0;
            debug << "No face data available; ";
        }

        memInfo.success = true;
        debug << "Memory info extraction successful";
        
    } catch (const std::exception& e) {
        debug << "Exception in GetMemoryInfo: " << e.what() << "; ";
        memInfo.success = false;
    } catch (...) {
        debug << "Unknown exception in GetMemoryInfo; ";
        memInfo.success = false;
    }
    
    memInfo.debugInfo = debug.str();
    return memInfo;
}

void ZKTecoDevice::ReadSizes() {
    auto memInfo = GetMemoryInfo();
    if (memInfo.success) {
        users_ = memInfo.usedUsers;
        fingers_ = memInfo.usedFingers;
        records_ = memInfo.usedRecords;
        usersCapacity_ = memInfo.totalUsers;
        fingersCapacity_ = memInfo.totalFingers;
        recordsCapacity_ = memInfo.totalRecords;
    }
}

std::vector<ZKTecoUser> ZKTecoDevice::GetUsers() {
    // Python: self.read_sizes()
    ReadSizes();
    
    // Python: if self.users == 0:
    if (users_ == 0) {
        nextUid_ = 0;
        nextUserId_ = "0";
        return std::vector<ZKTecoUser>();
    }
    
    std::vector<ZKTecoUser> users;
    int maxUid = 0;
    
    // Python: userdata, size = self.read_with_buffer(const.CMD_USERTEMP_RRQ, const.FCT_USER)
    auto [userdata, size] = ReadWithBuffer(ZKTecoConstants::CMD_USERTEMP_RRQ, ZKTecoConstants::FCT_USER);
    
    if (verbose_) std::cout << "user size " << size << " (= " << userdata.size() << ")" << std::endl;
    
    // Python: if size <= 4:
    if (size <= 4) {
        std::cout << "WRN: missing user data" << std::endl;
        return std::vector<ZKTecoUser>();
    }
    
    // Python: total_size = unpack("I",userdata[:4])[0]
    uint32_t totalSize = userdata[0] | (userdata[1] << 8) | (userdata[2] << 16) | (userdata[3] << 24);
    
    // Python: self.user_packet_size = total_size / self.users
    userPacketSize_ = totalSize / users_;
    
    // Python: if not self.user_packet_size in [28, 72]:
    if (userPacketSize_ != 28 && userPacketSize_ != 72) {
        if (verbose_) std::cout << "WRN packet size would be " << userPacketSize_ << std::endl;
    }
    
    // Python: userdata = userdata[4:]
    std::vector<uint8_t> userData(userdata.begin() + 4, userdata.end());
    
    // Python: if self.user_packet_size == 28:
    if (userPacketSize_ == 28) {
        while (userData.size() >= 28) {
            // Pad data to 28 bytes if needed
            if (userData.size() < 28) {
                userData.resize(28, 0);
            }
            
            // Python: uid, privilege, password, name, card, group_id, timezone, user_id = unpack('<HB5s8sIxBhI',userdata.ljust(28, b'\x00')[:28])
            uint16_t uid = userData[0] | (userData[1] << 8);

            uint8_t privilege = userData[2];
            
            // Extract password (5 bytes)
            std::string password;
            for (int i = 3; i < 8; i++) {
                if (userData[i] != 0) {
                    password += static_cast<char>(userData[i]);
                }
            }
            
            // Extract name (8 bytes)
            std::string name;
            for (int i = 8; i < 16; i++) {
                if (userData[i] != 0) {
                    name += static_cast<char>(userData[i]);
                } else {
                    break; // Stop at first null byte
                }
            }
            
            // Extract card (4 bytes)
            uint32_t card = userData[16] | (userData[17] << 8) | (userData[18] << 16) | (userData[19] << 24);
            
            // Skip 1 byte padding (userData[20])
            
            // Extract group_id (1 byte)
            uint8_t groupIdByte = userData[21];
            std::string groupId = std::to_string(groupIdByte);
            
            // Extract timezone (2 bytes, skip)
            // uint16_t timezone = userData[22] | (userData[23] << 8);
            
            // Extract user_id (4 bytes)
            uint32_t userIdInt = userData[24] | (userData[25] << 8) | (userData[26] << 16) | (userData[27] << 24);
            std::string userId = std::to_string(userIdInt);
            
            if (uid > maxUid) maxUid = uid;
            
            // Trim name
            name.erase(name.find_last_not_of(" \t\n\r\f\v") + 1);
            
            // Python: if not name: name = "NN-%s" % user_id
            if (name.empty()) {
                name = "NN-" + userId;
            }
            
            ZKTecoUser user(uid, name, privilege, password, groupId, userId, card);
            users.push_back(user);
            
            if (verbose_) std::cout << "[6]user: " << uid << " " << privilege << " " << password << " " << name << " " << card << " " << groupId << " " << userId << std::endl;
            
            // Python: userdata = userdata[28:]
            userData.erase(userData.begin(), userData.begin() + 28);
        }
    } else {
        // Python: while len(userdata) >= 72:
        while (userData.size() >= 72) {
            // Pad data to 72 bytes if needed
            if (userData.size() < 72) {
                userData.resize(72, 0);
            }
            
            // Python: uid, privilege, password, name, card, group_id, _, user_id = unpack('<HB8s24sIBx6sx24s', userdata.ljust(72, b'\x00')[:72])
            uint16_t uid = userData[0] | (userData[1] << 8);
            uint8_t privilege = userData[2];
            
            // Extract password (8 bytes)
            std::string password;
            for (int i = 3; i < 11; i++) {
                if (userData[i] != 0) {
                    password += static_cast<char>(userData[i]);
                }
            }
            
            // Extract name (24 bytes)
            std::string name;
            for (int i = 11; i < 35; i++) {
                if (userData[i] != 0) {
                    name += static_cast<char>(userData[i]);
                } else {
                    break; // Stop at first null byte
                }
            }

            // Extract card (4 bytes)
            uint32_t card = userData[35] | (userData[36] << 8) | (userData[37] << 16) | (userData[38] << 24);
            
            // Extract group_id (1 byte)
            uint8_t groupIdByte = userData[39];
            std::string groupId = std::to_string(groupIdByte);
            
            // Skip 1 byte padding (userData[40])
            // Skip 6 bytes (userData[41-46])
            // Skip 1 byte padding (userData[47])

            // Extract user_id (24 bytes)
            std::string userId;
            for (int i = 48; i < 72; i++) {
                if (userData[i] != 0) {
                    userId += static_cast<char>(userData[i]);
                } else {
                    break; // Stop at first null byte
                }
            }

            
            if (uid > maxUid) maxUid = uid;
            
            // Trim name
            name.erase(name.find_last_not_of(" \t\n\r\f\v") + 1);
            
            // Python: if not name: name = "NN-%s" % user_id
            if (name.empty()) {
                name = "NN-" + userId;
            }
            
            ZKTecoUser user(uid, name, privilege, password, groupId, userId, card);
            users.push_back(user);
            
            if (verbose_) std::cout << "[8]user: " << uid << " " << privilege << " " << password << " " << name << " " << card << " " << groupId << " " << userId << std::endl;
            
            // Python: userdata = userdata[72:]
            userData.erase(userData.begin(), userData.begin() + 72);
        }
    }
    
    // Python: max_uid += 1
    maxUid += 1;
    nextUid_ = maxUid;
    nextUserId_ = std::to_string(maxUid);
    
    // Python: while True: if any(u for u in users if u.user_id == self.next_user_id):
    while (true) {
        bool found = false;
        for (const auto& user : users) {
            if (user.GetUserId() == nextUserId_) {
                found = true;
                break;
            }
        }
        if (found) {
            maxUid += 1;
            nextUserId_ = std::to_string(maxUid);
        } else {
            break;
        }
    }
    
    return users;
}

int ZKTecoDevice::GetDataSize() {
    // Python: if response == const.CMD_PREPARE_DATA:
    if (lastResponse_ == ZKTecoConstants::CMD_PREPARE_DATA) {
        // Python: size = unpack('I', self.__data[:4])[0]
        // Extract unsigned int (4 bytes, little endian) from first 4 bytes of data
        if (lastData_.size() >= 4) {
            uint32_t size = lastData_[0] | (lastData_[1] << 8) | (lastData_[2] << 16) | (lastData_[3] << 24);
            return static_cast<int>(size);
        }
    }
    // Python: return 0
    return 0;
}

std::vector<uint8_t> ZKTecoDevice::ReceiveChunk() {
    // Python: if self.__response == const.CMD_DATA:
    if (lastResponse_ == ZKTecoConstants::CMD_DATA) {
        // Python: if self.tcp:
        if (!forceUdp_ && socket_ != INVALID_SOCKET) {
            if (verbose_) std::cout << "_rc_DATA! is " << lastData_.size() << " bytes, tcp length is " << tcpLength_ << std::endl;
            
            // Python: if len(self.__data) < (self.__tcp_length - 8):
            if (static_cast<int>(lastData_.size()) < (tcpLength_ - 8)) {
                int need = (tcpLength_ - 8) - static_cast<int>(lastData_.size());
                if (verbose_) std::cout << "need more data: " << need << std::endl;
                
                std::vector<uint8_t> moreData = ReceiveRawData(need);
                std::vector<uint8_t> result = lastData_;
                result.insert(result.end(), moreData.begin(), moreData.end());
                return result;
            } else {
                if (verbose_) std::cout << "Enough data" << std::endl;
                return lastData_;
            }
        } else {
            // UDP case
            if (verbose_) std::cout << "_rc len is " << lastData_.size() << std::endl;
            return lastData_;
        }
    }
    // Python: elif self.__response == const.CMD_PREPARE_DATA:
    else if (lastResponse_ == ZKTecoConstants::CMD_PREPARE_DATA) {
        std::vector<uint8_t> data;
        int size = GetDataSize();
        if (verbose_) std::cout << "receive chunk: prepare data size is " << size << std::endl;
        
        // Python: if self.tcp:
        if (!forceUdp_ && socket_ != INVALID_SOCKET) {
            std::vector<uint8_t> dataRecv;
            
            // Python: if len(self.__data) >= (8 + size):
            if (static_cast<int>(lastData_.size()) >= (8 + size)) {
                // Python: data_recv = self.__data[8:]
                dataRecv.assign(lastData_.begin() + 8, lastData_.end());
            } else {
                // Python: data_recv = self.__data[8:] + self.__sock.recv(size + 32)
                dataRecv.assign(lastData_.begin() + 8, lastData_.end());
                std::vector<uint8_t> additionalData = ReceiveRawData(size + 32);
                dataRecv.insert(dataRecv.end(), additionalData.begin(), additionalData.end());
            }
            
            // Python: resp, broken_header = self.__recieve_tcp_data(data_recv, size)
            auto [resp, brokenHeader] = ReceiveTcpData(dataRecv, size);
            data.insert(data.end(), resp.begin(), resp.end());
            
            // Python: if len(broken_header) < 16:
            std::vector<uint8_t> ackDataRecv;
            if (brokenHeader.size() < 16) {
                ackDataRecv = brokenHeader;
                std::vector<uint8_t> additionalData = ReceiveRawData(16);
                ackDataRecv.insert(ackDataRecv.end(), additionalData.begin(), additionalData.end());
            } else {
                ackDataRecv = brokenHeader;
            }
            
            // Python: if len(data_recv) < 16:
            if (ackDataRecv.size() < 16) {
                if (verbose_) std::cout << "trying to complete broken ACK " << ackDataRecv.size() << " /16" << std::endl;
                if (verbose_) {
                    for (auto byte : ackDataRecv) {
                        std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
                    }
                    std::cout << std::dec << std::endl;
                }
                std::vector<uint8_t> additionalData = ReceiveRawData(16 - static_cast<int>(ackDataRecv.size()));
                ackDataRecv.insert(ackDataRecv.end(), additionalData.begin(), additionalData.end());
            }
            
            // Python: if not self.__test_tcp_top(data_recv):
            if (TestTcpTop(ackDataRecv) == 0) {
                if (verbose_) std::cout << "invalid chunk tcp ACK OK" << std::endl;
                return std::vector<uint8_t>(); // Return empty vector (equivalent to None)
            }
            
            // Python: response = unpack('HHHH', data_recv[8:16])[0]
            if (ackDataRecv.size() >= 16) {
                uint16_t response = ackDataRecv[8] | (ackDataRecv[9] << 8); // Little endian
                
                // Python: if response == const.CMD_ACK_OK:
                if (response == ZKTecoConstants::CMD_ACK_OK) {
                    if (verbose_) std::cout << "chunk tcp ACK OK!" << std::endl;
                    return data;
                }
                
                if (verbose_) {
                    std::cout << "bad response ";
                    for (auto byte : ackDataRecv) {
                        std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
                    }
                    std::cout << std::dec << std::endl;
                }
                if (verbose_) {
                    for (auto byte : data) {
                        std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
                    }
                    std::cout << std::dec << std::endl;
                }
                return std::vector<uint8_t>(); // Return empty vector (equivalent to None)
            }
            
            return resp;
        } else {
            // UDP case - Python: while True:
            while (true) {
                std::vector<uint8_t> dataRecv = ReceiveRawData(1024 + 8);
                
                if (dataRecv.size() < 8) break;
                
                // Python: response = unpack('<4H', data_recv[:8])[0]
                uint16_t response = dataRecv[0] | (dataRecv[1] << 8); // Little endian
                if (verbose_) std::cout << "# packet response is: " << response << std::endl;
                
                // Python: if response == const.CMD_DATA:
                if (response == ZKTecoConstants::CMD_DATA) {
                    // Python: data.append(data_recv[8:])
                    data.insert(data.end(), dataRecv.begin() + 8, dataRecv.end());
                    size -= 1024;
                }
                // Python: elif response == const.CMD_ACK_OK:
                else if (response == ZKTecoConstants::CMD_ACK_OK) {
                    break;
                } else {
                    if (verbose_) std::cout << "broken!" << std::endl;
                    break;
                }
                
                if (verbose_) std::cout << "still needs " << size << std::endl;
            }
            return data;
        }
    } else {
        // Python: if self.verbose: print ("invalid response %s" % self.__response)
        if (verbose_) std::cout << "invalid response " << lastResponse_ << std::endl;
        return std::vector<uint8_t>(); // Return empty vector (equivalent to None)
    }
}

std::vector<uint8_t> ZKTecoDevice::ReadChunk(int start, int size) {
    // Python: for _retries in range(3):
    for (int retries = 0; retries < 3; retries++) {
        try {
            // Python: command = const._CMD_READ_BUFFER (which is CMD_READ_BUFFER)
            uint16_t command = ZKTecoConstants::CMD_READ_BUFFER;
            
            // Python: command_string = pack('<ii', start, size)
            std::vector<uint8_t> commandString(8); // 2 integers = 8 bytes
            // Pack start (little endian)
            uint32_t startValue = static_cast<uint32_t>(start);
            commandString[0] = startValue & 0xFF;
            commandString[1] = (startValue >> 8) & 0xFF;
            commandString[2] = (startValue >> 16) & 0xFF;
            commandString[3] = (startValue >> 24) & 0xFF;
            
            // Pack size (little endian)
            uint32_t sizeValue = static_cast<uint32_t>(size);
            commandString[4] = sizeValue & 0xFF;
            commandString[5] = (sizeValue >> 8) & 0xFF;
            commandString[6] = (sizeValue >> 16) & 0xFF;
            commandString[7] = (sizeValue >> 24) & 0xFF;
            
            // Python: if self.tcp: response_size = size + 32
            // Python: else: response_size = 1024 + 8
            int responseSize;
            if (!forceUdp_ && socket_ != INVALID_SOCKET) {
                responseSize = size + 32;
            } else {
                responseSize = 1024 + 8;
            }
            
            // Python: cmd_response = self.__send_command(command, command_string, response_size)
            std::vector<uint8_t> response;
            if (!SendCommand(command, commandString, responseSize, &response, "ReadChunk")) {
                if (verbose_) std::cout << "ReadChunk: SendCommand failed on retry " << retries << std::endl;
                continue; // Try again
            }
            
            // Python: data = self.__recieve_chunk()
            std::vector<uint8_t> data = ReceiveChunk();
            
            // Python: if data is not None: return data
            if (!data.empty()) {
                return data;
            }
            
            if (verbose_) std::cout << "ReadChunk: ReceiveChunk returned empty data on retry " << retries << std::endl;
            
        } catch (const std::exception& e) {
            if (verbose_) std::cout << "ReadChunk: Exception on retry " << retries << ": " << e.what() << std::endl;
        }
    }
    
    // Python: else: raise ZKErrorResponse("can't read chunk %i:[%i]" % (start, size))
    std::ostringstream oss;
    oss << "can't read chunk " << start << ":[" << size << "]";
    throw std::runtime_error(oss.str());
}

std::pair<std::vector<uint8_t>, int> ZKTecoDevice::ReadWithBuffer(uint8_t command, int fct, int ext) {
    // Python: if self.tcp: MAX_CHUNK = 0xFFc0
    // Python: else: MAX_CHUNK = 16 * 1024
    int MAX_CHUNK;
    if (!forceUdp_ && socket_ != INVALID_SOCKET) {
        MAX_CHUNK = 0xFFc0;  // 65472 bytes
    } else {
        MAX_CHUNK = 16 * 1024;  // 16384 bytes
    }
    
    // Python: command_string = pack('<bhii', 1, command, fct, ext)
    std::vector<uint8_t> commandString(11); // b(1) + h(2) + i(4) + i(4) = 11 bytes
    // Pack in little endian format: <bhii means byte, short, int, int
    commandString[0] = 1;  // byte: 1
    
    // Pack command (2 bytes short, little endian)
    uint16_t commandValue = static_cast<uint16_t>(command);
    commandString[1] = commandValue & 0xFF;
    commandString[2] = (commandValue >> 8) & 0xFF;
    
    // Pack fct (4 bytes int, little endian)
    uint32_t fctValue = static_cast<uint32_t>(fct);
    commandString[3] = fctValue & 0xFF;
    commandString[4] = (fctValue >> 8) & 0xFF;
    commandString[5] = (fctValue >> 16) & 0xFF;
    commandString[6] = (fctValue >> 24) & 0xFF;
    
    // Pack ext (4 bytes int, little endian)
    uint32_t extValue = static_cast<uint32_t>(ext);
    commandString[7] = extValue & 0xFF;
    commandString[8] = (extValue >> 8) & 0xFF;
    commandString[9] = (extValue >> 16) & 0xFF;
    commandString[10] = (extValue >> 24) & 0xFF;
    
    if (verbose_) {
        std::cout << "rwb cs ";
        for (auto byte : commandString) {
            std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte) << " ";
        }
        std::cout << std::dec << std::endl;
    }
    
    // Python: response_size = 1024
    int responseSize = 1024;
    std::vector<uint8_t> data;
    int start = 0;
    
    // Python: cmd_response = self.__send_command(const._CMD_PREPARE_BUFFER, command_string, response_size)
    std::vector<uint8_t> response;
    if (!SendCommand(ZKTecoConstants::CMD_PREPARE_BUFFER, commandString, responseSize, &response, "ReadWithBuffer")) {
        throw std::runtime_error("RWB Not supported");
    }
    
    // Python: if cmd_response['code'] == const.CMD_DATA:
    if (lastResponse_ == ZKTecoConstants::CMD_DATA) {
        // Python: if self.tcp:
        if (!forceUdp_ && socket_ != INVALID_SOCKET) {
            if (verbose_) std::cout << "DATA! is " << lastData_.size() << " bytes, tcp length is " << tcpLength_ << std::endl;
            
            // Python: if len(self.__data) < (self.__tcp_length - 8):
            if (static_cast<int>(lastData_.size()) < (tcpLength_ - 8)) {
                int need = (tcpLength_ - 8) - static_cast<int>(lastData_.size());
                if (verbose_) std::cout << "need more data: " << need << std::endl;
                
                std::vector<uint8_t> moreData = ReceiveRawData(need);
                std::vector<uint8_t> result = lastData_;
                result.insert(result.end(), moreData.begin(), moreData.end());
                return std::make_pair(result, static_cast<int>(result.size()));
            } else {
                if (verbose_) std::cout << "Enough data" << std::endl;
                int size = static_cast<int>(lastData_.size());
                return std::make_pair(lastData_, size);
            }
        } else {
            // UDP case
            int size = static_cast<int>(lastData_.size());
            return std::make_pair(lastData_, size);
        }
    }
    
    // Python: size = unpack('I', self.__data[1:5])[0]
    if (lastData_.size() < 5) {
        throw std::runtime_error("Insufficient data for size extraction");
    }
    
    uint32_t size = lastData_[1] | (lastData_[2] << 8) | (lastData_[3] << 16) | (lastData_[4] << 24);
    if (verbose_) std::cout << "size will be " << size << std::endl;
    
    // Python: remain = size % MAX_CHUNK
    int remain = size % MAX_CHUNK;
    
    // Python: packets = (size-remain) // MAX_CHUNK
    int packets = (size - remain) / MAX_CHUNK;
    
    if (verbose_) std::cout << "rwb: #" << packets << " packets of max " << MAX_CHUNK << " bytes, and extra " << remain << " bytes remain" << std::endl;
    
    // Python: for _wlk in range(packets):
    for (int wlk = 0; wlk < packets; wlk++) {
        std::vector<uint8_t> chunkData = ReadChunk(start, MAX_CHUNK);
        data.insert(data.end(), chunkData.begin(), chunkData.end());
        start += MAX_CHUNK;
    }
    
    // Python: if remain:
    if (remain > 0) {
        std::vector<uint8_t> chunkData = ReadChunk(start, remain);
        data.insert(data.end(), chunkData.begin(), chunkData.end());
        start += remain;
    }
    
    // Python: self.free_data()
    FreeData();
    
    if (verbose_) std::cout << "_read w/chunk " << start << " bytes" << std::endl;
    
    // Python: return b''.join(data), start
    return std::make_pair(data, start);
}

void ZKTecoDevice::FreeData() {
    // Python equivalent: sends CMD_FREE_DATA command to free device buffer
    try {
        std::vector<uint8_t> response;
        SendCommand(ZKTecoConstants::CMD_FREE_DATA, std::vector<uint8_t>{}, 1024, &response, "FreeData");
        if (verbose_) std::cout << "FreeData command sent" << std::endl;
    } catch (const std::exception& e) {
        if (verbose_) std::cout << "FreeData error: " << e.what() << std::endl;
    }
}

// Utility methods
std::string ZKTecoDevice::DecodeTime(const std::vector<uint8_t>& timeBytes) {
    if (timeBytes.size() < 4) return "";
    
    // Decode as little-endian uint32 (matching Python's unpack('<I'))
    uint32_t t = timeBytes[0] | (timeBytes[1] << 8) | (timeBytes[2] << 16) | (timeBytes[3] << 24);
    
    // Decode time based on pyzk algorithm
    int second = t % 60;
    t /= 60;
    int minute = t % 60;
    t /= 60;
    int hour = t % 24;
    t /= 24;
    int day = (t % 31) + 1;
    t /= 31;
    int month = (t % 12) + 1;
    t /= 12;
    int year = t + 2000;
    
    // Validate date components
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 ||
        hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
        if (verbose_) {
            std::cout << "Invalid time decoded: " << year << "-" << month << "-" << day 
                      << "T" << hour << ":" << minute << ":" << second 
                      << " from bytes: " << std::hex << t << std::dec << std::endl;
        }
        return "";
    }
    
    std::ostringstream oss;
    oss << year << "-" << std::setfill('0') << std::setw(2) << month 
        << "-" << std::setw(2) << day << "T"
        << std::setw(2) << hour << ":" << std::setw(2) << minute 
        << ":" << std::setw(2) << second;
    
    return oss.str();
}

std::vector<uint8_t> ZKTecoDevice::EncodeTime(const std::string& timestamp) {
    // Simplified time encoding - would need proper ISO timestamp parsing
    std::vector<uint8_t> result(4);
    
    // Get current time as fallback
    auto now = std::chrono::system_clock::now();
    auto time_t = std::chrono::system_clock::to_time_t(now);
    auto tm = *std::gmtime(&time_t);
    
    uint32_t encoded = ((tm.tm_year - 100) * 12 * 31 + tm.tm_mon * 31 + tm.tm_mday - 1) * 
                      (24 * 60 * 60) + (tm.tm_hour * 60 + tm.tm_min) * 60 + tm.tm_sec;
    
    *reinterpret_cast<uint32_t*>(result.data()) = encoded;
    
    return result;
}

std::vector<ZKTecoAttendance> ZKTecoDevice::GetAttendance() {
    // Python: self.read_sizes()
    ReadSizes();
    
    // Python: if self.records == 0:
    if (records_ == 0) {
        return std::vector<ZKTecoAttendance>();
    }
    
    // Python: users = self.get_users()
    std::vector<ZKTecoUser> users = GetUsers();
    if (verbose_) std::cout << "Users: " << users.size() << std::endl;
    
    std::vector<ZKTecoAttendance> attendances;
    
    // Python: attendance_data, size = self.read_with_buffer(const.CMD_ATTLOG_RRQ)
    auto [attendanceData, size] = ReadWithBuffer(ZKTecoConstants::CMD_ATTLOG_RRQ);
    
    if (verbose_) std::cout << "attendance size " << size << " (= " << attendanceData.size() << ")" << std::endl;
    
    // Python: if size < 4:
    if (size < 4) {
        if (verbose_) std::cout << "WRN: no attendance data" << std::endl;
        return std::vector<ZKTecoAttendance>();
    }
    
    // Python: total_size = unpack("I", attendance_data[:4])[0]
    uint32_t totalSize = attendanceData[0] | (attendanceData[1] << 8) | (attendanceData[2] << 16) | (attendanceData[3] << 24);
    
    // Python: record_size = total_size // self.records
    int recordSize = totalSize / records_;
    if (verbose_) std::cout << "record_size is " << recordSize << std::endl;
    
    // Python: attendance_data = attendance_data[4:]
    std::vector<uint8_t> data(attendanceData.begin() + 4, attendanceData.end());
    
    // Python: if record_size == 8:
    if (recordSize == 8) {
        while (data.size() >= 8) {
            // Python: uid, status, timestamp, punch = unpack('HB4sB', attendance_data.ljust(8, b'\x00')[:8])
            // Pad data to 8 bytes if needed
            if (data.size() < 8) {
                data.resize(8, 0);
            }
            
            // Extract fields from 8-byte record
            uint16_t uid = data[0] | (data[1] << 8);
            uint8_t status = data[2];
            
            // Extract timestamp (4 bytes)
            std::vector<uint8_t> timestampBytes(data.begin() + 3, data.begin() + 7);
            std::string timestamp = DecodeTime(timestampBytes);
            
            uint8_t punch = data[7];
            
            if (verbose_) {
                std::cout << "Record 8-byte: ";
                for (int i = 0; i < 8; i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(data[i]) << " ";
                }
                std::cout << std::dec << std::endl;
            }
            
            // Python: tuser = list(filter(lambda x: x.uid == uid, users))
            std::string userId = std::to_string(uid);
            for (const auto& user : users) {
                if (user.GetUid() == uid) {
                    userId = user.GetUserId();
                    break;
                }
            }
            
            // Python: attendance = Attendance(user_id, timestamp, status, punch, uid)
            ZKTecoAttendance attendance(userId, timestamp, status, punch, uid);
            attendances.push_back(attendance);
            
            // Python: attendance_data = attendance_data[8:]
            data.erase(data.begin(), data.begin() + 8);
        }
    }
    // Python: elif record_size == 16:
    else if (recordSize == 16) {
        while (data.size() >= 16) {
            // Python: user_id, timestamp, status, punch, reserved, workcode = unpack('<I4sBB2sI', attendance_data.ljust(16, b'\x00')[:16])
            // Pad data to 16 bytes if needed
            if (data.size() < 16) {
                data.resize(16, 0);
            }
            
            // Extract fields from 16-byte record
            uint32_t userIdInt = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
            std::string userId = std::to_string(userIdInt);
            
            // Extract timestamp (4 bytes)
            std::vector<uint8_t> timestampBytes(data.begin() + 4, data.begin() + 8);
            std::string timestamp = DecodeTime(timestampBytes);
            
            uint8_t status = data[8];
            uint8_t punch = data[9];
            
            // Skip reserved (2 bytes) and workcode (4 bytes)
            
            if (verbose_) {
                std::cout << "Record 16-byte: ";
                for (int i = 0; i < 16; i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(data[i]) << " ";
                }
                std::cout << std::dec << std::endl;
            }
            
            // Python: tuser = list(filter(lambda x: x.user_id == user_id, users))
            int uid = userIdInt; // Default to user_id as uid
            for (const auto& user : users) {
                if (user.GetUserId() == userId) {
                    uid = user.GetUid();
                    break;
                }
            }
            
            // Python: attendance = Attendance(user_id, timestamp, status, punch, uid)
            ZKTecoAttendance attendance(userId, timestamp, status, punch, uid);
            attendances.push_back(attendance);
            
            // Python: attendance_data = attendance_data[16:]
            data.erase(data.begin(), data.begin() + 16);
        }
    }
    // Python: else:
    else {
        // Default case for other record sizes (typically 40 bytes)
        while (data.size() >= 40) {
            // Python: uid, user_id, status, timestamp, punch, space = unpack('<H24sB4sB8s', attendance_data.ljust(40, b'\x00')[:40])
            // Pad data to 40 bytes if needed
            if (data.size() < 40) {
                data.resize(40, 0);
            }
            
            // Extract fields from 40-byte record
            uint16_t uid = data[0] | (data[1] << 8);
            
            // Extract user_id (24 bytes, null-terminated)
            std::string userId;
            for (int i = 2; i < 26; i++) {
                if (data[i] != 0) {
                    userId += static_cast<char>(data[i]);
                } else {
                    break; // Stop at first null byte
                }
            }
            
            uint8_t status = data[26];
            
            // Extract timestamp (4 bytes)
            std::vector<uint8_t> timestampBytes(data.begin() + 27, data.begin() + 31);
            std::string timestamp = DecodeTime(timestampBytes);
            
            uint8_t punch = data[31];
            
            // Skip space (8 bytes)
            
            if (verbose_) {
                std::cout << "Record 40-byte: ";
                for (int i = 0; i < 40; i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(data[i]) << " ";
                }
                std::cout << std::dec << std::endl;
            }
            
            // Python: attendance = Attendance(user_id, timestamp, status, punch, uid)
            ZKTecoAttendance attendance(userId, timestamp, status, punch, uid);
            attendances.push_back(attendance);
            
            // Python: attendance_data = attendance_data[record_size:]
            data.erase(data.begin(), data.begin() + recordSize);
        }
    }
    
    return attendances;
}

std::vector<ZKTecoFinger> ZKTecoDevice::GetTemplates() {
    // Python: self.read_sizes()
    ReadSizes();
    
    // Python: if self.fingers == 0:
    if (fingers_ == 0) {
        return std::vector<ZKTecoFinger>();
    }
    
    std::vector<ZKTecoFinger> templates;
    
    // Python: templatedata, size = self.read_with_buffer(const.CMD_DB_RRQ, const.FCT_FINGERTMP)
    auto [templateData, size] = ReadWithBuffer(ZKTecoConstants::CMD_DB_RRQ, ZKTecoConstants::FCT_FINGERTMP);
    
    if (verbose_) std::cout << "template size " << size << " (= " << templateData.size() << ")" << std::endl;
    
    // Python: if size < 4:
    if (size < 4) {
        if (verbose_) std::cout << "WRN: no user data" << std::endl;
        return std::vector<ZKTecoFinger>();
    }
    
    // Python: total_size = unpack('i', templatedata[0:4])[0]
    uint32_t totalSize = templateData[0] | (templateData[1] << 8) | (templateData[2] << 16) | (templateData[3] << 24);
    if (verbose_) std::cout << "get template total size " << totalSize << ", size " << size << " len " << templateData.size() << std::endl;
    
    // Python: templatedata = templatedata[4:]
    std::vector<uint8_t> data(templateData.begin() + 4, templateData.end());
    
    // Python: while total_size:
    while (totalSize > 0) {
        // Python: size, uid, fid, valid = unpack('HHbb',templatedata[:6])
        if (data.size() < 6) {
            if (verbose_) std::cout << "Insufficient data for template header" << std::endl;
            break;
        }
        
        uint16_t templateSize = data[0] | (data[1] << 8);
        uint16_t uid = data[2] | (data[3] << 8);
        uint8_t fid = data[4];
        uint8_t valid = data[5];
        
        if (verbose_) std::cout << "Template: size=" << templateSize << ", uid=" << uid << ", fid=" << (int)fid << ", valid=" << (int)valid << std::endl;
        
        // Python: template = unpack("%is" % (size-6), templatedata[6:size])[0]
        if (data.size() < templateSize) {
            if (verbose_) std::cout << "Insufficient data for template body" << std::endl;
            break;
        }
        
        std::vector<uint8_t> templateBytes(data.begin() + 6, data.begin() + templateSize);
        
        // Python: finger = Finger(uid, fid, valid, template)
        ZKTecoFinger finger(uid, fid, valid, templateBytes);
        if (verbose_) std::cout << "Created finger template: " << finger.ToString() << std::endl;
        
        templates.push_back(finger);
        
        // Python: templatedata = templatedata[size:]
        data.erase(data.begin(), data.begin() + templateSize);
        
        // Python: total_size -= size
        totalSize -= templateSize;
    }

    
    return templates;
}

ZKTecoFinger* ZKTecoDevice::GetUserTemplate(int uid, int tempId, const std::string& userId) {
    // Python: if not uid:
    if (uid == 0) {
        // Python: users = self.get_users()
        std::vector<ZKTecoUser> users = GetUsers();
        
        // Python: users = list(filter(lambda x: x.user_id==str(user_id), users))
        std::vector<ZKTecoUser> filteredUsers;
        for (const auto& user : users) {
            if (user.GetUserId() == userId) {
                filteredUsers.push_back(user);
            }
        }
        
        // Python: if not users:
        if (filteredUsers.empty()) {
            if (verbose_) std::cout << "No user found with user_id: " << userId << std::endl;
            return nullptr;
        }
        
        // Python: uid = users[0].uid
        uid = filteredUsers[0].GetUid();
    }
    
    // Python: for _retries in range(3):
    for (int retries = 0; retries < 3; retries++) {
        // Python: command = const._CMD_GET_USERTEMP
        uint16_t command = ZKTecoConstants::_CMD_GET_USERTEMP;
        
        // Python: command_string = pack('hb', uid, temp_id)
        std::vector<uint8_t> commandString;
        commandString.push_back(uid & 0xFF);
        commandString.push_back((uid >> 8) & 0xFF);
        commandString.push_back(tempId & 0xFF);
        
        // Python: response_size = 1024 + 8
        int responseSize = 1024 + 8;
        
        // Python: cmd_response = self.__send_command(command, command_string, response_size)
        std::vector<uint8_t> response;
        if (!SendCommand(command, commandString, responseSize, &response, "GetUserTemplate")) {
            if (verbose_) std::cout << "Failed to send command for get_user_template" << std::endl;
            continue;
        }
        
        // Python: data = self.__recieve_chunk()
        std::vector<uint8_t> data = ReceiveChunk();
        
        // Python: if data is not None:
        if (!data.empty()) {
            // Python: resp = data[:-1]
            std::vector<uint8_t> resp(data.begin(), data.end() - 1);
            
            // Python: if resp[-6:] == b'\x00\x00\x00\x00\x00\x00': # padding? bug?
            if (resp.size() >= 6) {
                bool isPadding = true;
                for (int i = 0; i < 6; i++) {
                    if (resp[resp.size() - 6 + i] != 0) {
                        isPadding = false;
                        break;
                    }
                }
                if (isPadding) {
                    // Python: resp = resp[:-6]
                    resp.resize(resp.size() - 6);
                }
            }
            
            // Python: return Finger(uid, temp_id, 1, resp)
            return new ZKTecoFinger(uid, tempId, 1, resp);
        }
        
        // Python: if self.verbose: print ("retry get_user_template")
        if (verbose_) std::cout << "retry get_user_template" << std::endl;
    }
    
    // Python: else:
    // Python:     if self.verbose: print ("Can't read/find finger")
    // Python:     return None
    if (verbose_) std::cout << "Can't read/find finger" << std::endl;
    return nullptr;
}

bool ZKTecoDevice::SetUser(int uid, const std::string& name, int privilege, int password, 
                           const std::string& groupId, const std::string& userId, int card) {
    if (verbose_) {
        std::cout << "Setting user: uid=" << uid << ", name='" << name << "', privilege=" << privilege 
                  << ", password=" << password << ", groupId='" << groupId << "', userId='" << userId 
                  << "', card=" << card << std::endl;
    }
    
    // Enable device first (some devices require this for user operations)
    std::vector<uint8_t> enableResponse;
    SendCommand(ZKTecoConstants::CMD_ENABLEDEVICE, std::vector<uint8_t>{}, 8, &enableResponse, "EnableDevice");
    
    // Python: command = const.CMD_USER_WRQ
    uint16_t command = ZKTecoConstants::CMD_USER_WRQ;
    
    // Create local variables for modifications
    int finalUid = uid;
    std::string finalUserId = userId;
    std::string finalGroupId = groupId;
    
    // Python: if uid is None:
    if (finalUid == 0) {
        // Python: uid = self.next_uid
        finalUid = nextUid_;
        // Python: if not user_id:
        if (finalUserId.empty()) {
            // Python: user_id = self.next_user_id
            finalUserId = nextUserId_;
        }
    }
    
    // Python: if not user_id:
    if (finalUserId.empty()) {
        // Python: user_id = str(uid) #ZK6 needs uid2 == uid
        finalUserId = std::to_string(finalUid);
    }
    
    // Python: if privilege not in [const.USER_DEFAULT, const.USER_ADMIN]:
    if (privilege != ZKTecoConstants::USER_DEFAULT && privilege != ZKTecoConstants::USER_ADMIN) {
        // Python: privilege = const.USER_DEFAULT
        privilege = ZKTecoConstants::USER_DEFAULT;
    }
    
    // Python: privilege = int(privilege)
    privilege = static_cast<int>(privilege);
    
    std::vector<uint8_t> commandString;
    
    // Python: if self.user_packet_size == 28: #self.firmware == 6:
    if (userPacketSize_ == 28) {
        // Python: if not group_id:
        if (finalGroupId.empty()) {
            // Python: group_id = 0
            finalGroupId = "0";
        }
        
        try {
            // Python: command_string = pack('HB5s8sIxBHI', uid, privilege, password.encode(self.encoding, errors='ignore'), name.encode(self.encoding, errors='ignore'), card, int(group_id), 0, int(user_id))
            
            // Pack uid (2 bytes, little endian)
            commandString.push_back(finalUid & 0xFF);
            commandString.push_back((finalUid >> 8) & 0xFF);
            
            // Pack privilege (1 byte)
            commandString.push_back(privilege & 0xFF);
            
            // Pack password (5 bytes, encoded)
            std::string passwordStr = std::to_string(password);
            std::vector<uint8_t> passwordBytes(passwordStr.begin(), passwordStr.end());
            passwordBytes.resize(5, 0); // Pad to 5 bytes
            commandString.insert(commandString.end(), passwordBytes.begin(), passwordBytes.end());
            
            // Pack name (8 bytes, encoded)
            std::vector<uint8_t> nameBytes(name.begin(), name.end());
            nameBytes.resize(8, 0); // Pad to 8 bytes
            commandString.insert(commandString.end(), nameBytes.begin(), nameBytes.end());
            
            // Pack card (4 bytes, little endian)
            commandString.push_back(card & 0xFF);
            commandString.push_back((card >> 8) & 0xFF);
            commandString.push_back((card >> 16) & 0xFF);
            commandString.push_back((card >> 24) & 0xFF);
            
            // Pack group_id (4 bytes, little endian)
            int groupIdInt = std::stoi(finalGroupId);
            commandString.push_back(groupIdInt & 0xFF);
            commandString.push_back((groupIdInt >> 8) & 0xFF);
            commandString.push_back((groupIdInt >> 16) & 0xFF);
            commandString.push_back((groupIdInt >> 24) & 0xFF);
            
            // Pack 0 (1 byte)
            commandString.push_back(0);
            
            // Pack user_id (2 bytes, little endian)
            int userIdInt = std::stoi(finalUserId);
            commandString.push_back(userIdInt & 0xFF);
            commandString.push_back((userIdInt >> 8) & 0xFF);
            
            // Pack 0 (1 byte)
            commandString.push_back(0);
            
        } catch (const std::exception& e) {
            if (verbose_) std::cout << "Error packing user data: " << e.what() << std::endl;
            return false;
        }
    } else {
        // Python: name_pad = name.encode(self.encoding, errors='ignore').ljust(24, b'\x00')[:24]
        std::vector<uint8_t> nameBytes(name.begin(), name.end());
        nameBytes.resize(24, 0); // Pad to 24 bytes
        
        // Python: card_str = pack('<I', int(card))[:4]
        std::vector<uint8_t> cardBytes;
        cardBytes.push_back(card & 0xFF);
        cardBytes.push_back((card >> 8) & 0xFF);
        cardBytes.push_back((card >> 16) & 0xFF);
        cardBytes.push_back((card >> 24) & 0xFF);
        
        // Python: command_string = pack('HB8s24s4sB7sx24s', uid, privilege, password.encode(self.encoding, errors='ignore'), name_pad, card_str, group_id, str(group_id).encode(), user_id.encode())
        
        // Pack uid (2 bytes, little endian)
        commandString.push_back(finalUid & 0xFF);
        commandString.push_back((finalUid >> 8) & 0xFF);
        
        // Pack privilege (1 byte)
        commandString.push_back(privilege & 0xFF);
        
        // Pack password (8 bytes, encoded)
        std::string passwordStr = std::to_string(password);
        std::vector<uint8_t> passwordBytes(passwordStr.begin(), passwordStr.end());
        passwordBytes.resize(8, 0); // Pad to 8 bytes
        commandString.insert(commandString.end(), passwordBytes.begin(), passwordBytes.end());
        
        // Pack name_pad (24 bytes)
        commandString.insert(commandString.end(), nameBytes.begin(), nameBytes.end());
        
        // Pack card_str (4 bytes)
        commandString.insert(commandString.end(), cardBytes.begin(), cardBytes.end());
        
        // Pack group_id (1 byte)
        int groupIdInt = finalGroupId.empty() ? 0 : std::stoi(finalGroupId);
        commandString.push_back(groupIdInt & 0xFF);
        
        // Pack str(group_id).encode() (7 bytes)
        std::string groupIdStr = finalGroupId.empty() ? "0" : finalGroupId;
        std::vector<uint8_t> groupIdStrBytes(groupIdStr.begin(), groupIdStr.end());
        groupIdStrBytes.resize(7, 0); // Pad to 7 bytes
        commandString.insert(commandString.end(), groupIdStrBytes.begin(), groupIdStrBytes.end());
        
        // Pack x (1 byte)
        commandString.push_back(0);
        
        // Pack user_id.encode() (24 bytes)
        std::vector<uint8_t> userIdBytes(finalUserId.begin(), finalUserId.end());
        userIdBytes.resize(24, 0); // Pad to 24 bytes
        commandString.insert(commandString.end(), userIdBytes.begin(), userIdBytes.end());
    }
    
    // Python: response_size = 1024 #TODO check response?
    int responseSize = 1024;
    
    // Python: cmd_response = self.__send_command(command, command_string, response_size)
    std::vector<uint8_t> response;
    if (!SendCommand(command, commandString, responseSize, &response, "SetUser")) {
        if (verbose_) std::cout << "Failed to send set user command" << std::endl;
        return false;
    }
    
    // Python: if self.verbose: print("Response: %s" % cmd_response)
    if (verbose_) {
        std::cout << "Set user response size: " << response.size() << std::endl;
        if (!response.empty()) {
            std::cout << "Response bytes: ";
            for (size_t i = 0; i < std::min(response.size(), size_t(16)); ++i) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(response[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
    }
    
    // Python: if not cmd_response.get('status'):
    if (response.empty()) {
        if (verbose_) std::cout << "Set user failed - no response" << std::endl;
        return false;
    }
    
    // Check response status (first 2 bytes should be ACK_OK or other success codes)
    if (response.size() >= 2) {
        uint16_t responseCode = (response[1] << 8) | response[0];
        if (verbose_) std::cout << "Response code: " << responseCode << std::endl;
        
        // Accept multiple success codes (some devices might return different codes)
        if (responseCode != ZKTecoConstants::CMD_ACK_OK && 
            responseCode != ZKTecoConstants::CMD_ACK_DATA &&
            responseCode != 2007) { // Some devices return 2007 as success
            if (verbose_) std::cout << "Set user failed with response code: " << responseCode << std::endl;
            return false;
        }
    }
    
    // Python: self.refresh_data()
    // Note: We don't have refresh_data() in C++, so we'll update our local counters
    
    // Python: if self.next_uid == uid:
    if (nextUid_ == finalUid) {
        // Python: self.next_uid += 1 # better recalculate again
        nextUid_ += 1;
    }
    
    // Python: if self.next_user_id == user_id:
    if (nextUserId_ == finalUserId) {
        // Python: self.next_user_id = str(self.next_uid)
        nextUserId_ = std::to_string(nextUid_);
    }
    
    if (verbose_) std::cout << "User set successfully" << std::endl;
    return true;
}

bool ZKTecoDevice::DeleteUser(int uid, const std::string& userId) {
    if (verbose_) {
        std::cout << "Deleting user: uid=" << uid << ", userId='" << userId << "'" << std::endl;
    }
    
    // Python: if not uid:
    if (uid == 0) {
        // Python: users = self.get_users()
        std::vector<ZKTecoUser> users = GetUsers();
        
        // Python: users = list(filter(lambda x: x.user_id==str(user_id), users))
        std::vector<ZKTecoUser> filteredUsers;
        for (const auto& user : users) {
            if (user.GetUserId() == userId) {
                filteredUsers.push_back(user);
            }
        }
        
        // Python: if not users:
        if (filteredUsers.empty()) {
            if (verbose_) std::cout << "No user found with user_id: " << userId << std::endl;
            return false;
        }
        
        // Python: uid = users[0].uid
        uid = filteredUsers[0].GetUid();
    }
    
    // Python: command = const.CMD_DELETE_USER
    uint16_t command = ZKTecoConstants::CMD_DELETE_USER;
    
    // Python: command_string = pack('h', uid)
    std::vector<uint8_t> commandString;
    commandString.push_back(uid & 0xFF);
    commandString.push_back((uid >> 8) & 0xFF);
    
    // Python: cmd_response = self.__send_command(command, command_string)
    std::vector<uint8_t> response;
    if (!SendCommand(command, commandString, 8, &response, "DeleteUser")) {
        if (verbose_) std::cout << "Failed to send delete user command" << std::endl;
        return false;
    }
    
    if (verbose_) {
        std::cout << "Delete user response size: " << response.size() << std::endl;
        if (!response.empty()) {
            std::cout << "Response bytes: ";
            for (size_t i = 0; i < std::min(response.size(), size_t(16)); ++i) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(response[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
    }
    
    // Python: if not cmd_response.get('status'):
    if (response.empty()) {
        if (verbose_) std::cout << "Delete user failed - no response" << std::endl;
        return false;
    }
    
    // Check response status (first 2 bytes should be ACK_OK or other success codes)
    if (response.size() >= 2) {
        uint16_t responseCode = (response[1] << 8) | response[0];
        if (verbose_) std::cout << "Response code: " << responseCode << std::endl;
        
        // Accept multiple success codes (some devices might return different codes)
        if (responseCode != ZKTecoConstants::CMD_ACK_OK && 
            responseCode != ZKTecoConstants::CMD_ACK_DATA &&
            responseCode != 2007) { // Some devices return 2007 as success
            if (verbose_) std::cout << "Delete user failed with response code: " << responseCode << std::endl;
            return false;
        }
    }
    
    // Python: self.refresh_data()
    // Note: We don't have refresh_data() in C++, so we'll update our local counters
    
    // Python: if uid == (self.next_uid - 1):
    if (uid == (nextUid_ - 1)) {
        // Python: self.next_uid = uid
        nextUid_ = uid;
    }
    
    if (verbose_) std::cout << "User deleted successfully" << std::endl;
    return true;
}

bool ZKTecoDevice::DeleteUserTemplate(int uid, int tempId, const std::string& userId) {
    if (verbose_) {
        std::cout << "Deleting user template: uid=" << uid << ", tempId=" << tempId << ", userId='" << userId << "'" << std::endl;
    }
    
    // Python: if self.tcp and user_id:
    if (!forceUdp_ && socket_ != INVALID_SOCKET && !userId.empty()) {
        // Python: command = const._CMD_DEL_USER_TEMP
        uint16_t command = ZKTecoConstants::_CMD_DEL_USER_TEMP;
        
        // Python: command_string = pack('<24sB', str(user_id).encode(), temp_id)
        std::vector<uint8_t> commandString;
        
        // Pack user_id (24 bytes, encoded)
        std::vector<uint8_t> userIdBytes(userId.begin(), userId.end());
        userIdBytes.resize(24, 0); // Pad to 24 bytes
        commandString.insert(commandString.end(), userIdBytes.begin(), userIdBytes.end());
        
        // Pack temp_id (1 byte)
        commandString.push_back(tempId & 0xFF);
        
        // Python: cmd_response = self.__send_command(command, command_string)
        std::vector<uint8_t> response;
        if (!SendCommand(command, commandString, 8, &response, "DeleteUserTemplate")) {
            if (verbose_) std::cout << "Failed to send delete user template command (TCP)" << std::endl;
            return false;
        }
        
        if (verbose_) {
            std::cout << "Delete user template response size: " << response.size() << std::endl;
            if (!response.empty()) {
                std::cout << "Response bytes: ";
                for (size_t i = 0; i < std::min(response.size(), size_t(16)); ++i) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(response[i]) << " ";
                }
                std::cout << std::dec << std::endl;
            }
        }
        
        // Python: if cmd_response.get('status'):
        if (response.empty()) {
            if (verbose_) std::cout << "Delete user template failed - no response (TCP)" << std::endl;
            return false;
        }
        
        // Check response status
        if (response.size() >= 2) {
            uint16_t responseCode = (response[1] << 8) | response[0];
            if (verbose_) std::cout << "Response code: " << responseCode << std::endl;
            
            // Accept multiple success codes
            if (responseCode != ZKTecoConstants::CMD_ACK_OK && 
                responseCode != ZKTecoConstants::CMD_ACK_DATA &&
                responseCode != 2007) {
                if (verbose_) std::cout << "Delete user template failed with response code: " << responseCode << " (TCP)" << std::endl;
                return false;
            }
        }
        
        if (verbose_) std::cout << "User template deleted successfully (TCP)" << std::endl;
        return true;
    }
    
    // Python: if not uid:
    if (uid == 0) {
        // Python: users = self.get_users()
        std::vector<ZKTecoUser> users = GetUsers();
        
        // Python: users = list(filter(lambda x: x.user_id==str(user_id), users))
        std::vector<ZKTecoUser> filteredUsers;
        for (const auto& user : users) {
            if (user.GetUserId() == userId) {
                filteredUsers.push_back(user);
            }
        }
        
        // Python: if not users:
        if (filteredUsers.empty()) {
            if (verbose_) std::cout << "No user found with user_id: " << userId << std::endl;
            return false;
        }
        
        // Python: uid = users[0].uid
        uid = filteredUsers[0].GetUid();
    }
    
    // Python: command = const.CMD_DELETE_USERTEMP
    uint16_t command = ZKTecoConstants::CMD_DELETE_USERTEMP;
    
    // Python: command_string = pack('hb', uid, temp_id)
    std::vector<uint8_t> commandString;
    commandString.push_back(uid & 0xFF);
    commandString.push_back((uid >> 8) & 0xFF);
    commandString.push_back(tempId & 0xFF);
    
    // Python: cmd_response = self.__send_command(command, command_string)
    std::vector<uint8_t> response;
    if (!SendCommand(command, commandString, 8, &response, "DeleteUserTemplate")) {
        if (verbose_) std::cout << "Failed to send delete user template command" << std::endl;
        return false;
    }
    
    if (verbose_) {
        std::cout << "Delete user template response size: " << response.size() << std::endl;
        if (!response.empty()) {
            std::cout << "Response bytes: ";
            for (size_t i = 0; i < std::min(response.size(), size_t(16)); ++i) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(response[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
    }
    
    // Python: if cmd_response.get('status'):
    if (response.empty()) {
        if (verbose_) std::cout << "Delete user template failed - no response" << std::endl;
        return false;
    }
    
    // Check response status
    if (response.size() >= 2) {
        uint16_t responseCode = (response[1] << 8) | response[0];
        if (verbose_) std::cout << "Response code: " << responseCode << std::endl;
        
        // Accept multiple success codes
        if (responseCode != ZKTecoConstants::CMD_ACK_OK && 
            responseCode != ZKTecoConstants::CMD_ACK_DATA &&
            responseCode != 2007) {
            if (verbose_) std::cout << "Delete user template failed with response code: " << responseCode << std::endl;
            return false;
        }
    }
    
    if (verbose_) std::cout << "User template deleted successfully" << std::endl;
    return true;
}

bool ZKTecoDevice::TestVoice(int index) {
    if (verbose_) {
        std::cout << "Testing voice with index: " << index << std::endl;
    }
    
    // Python: command = const.CMD_TESTVOICE
    uint16_t command = ZKTecoConstants::CMD_TESTVOICE;
    
    // Python: command_string = pack("I", index)
    std::vector<uint8_t> commandString;
    commandString.push_back(index & 0xFF);
    commandString.push_back((index >> 8) & 0xFF);
    commandString.push_back((index >> 16) & 0xFF);
    commandString.push_back((index >> 24) & 0xFF);
    
    // Python: cmd_response = self.__send_command(command, command_string)
    std::vector<uint8_t> response;
    if (!SendCommand(command, commandString, 8, &response, "TestVoice")) {
        if (verbose_) std::cout << "Failed to send test voice command" << std::endl;
        return false;
    }
    
    if (verbose_) {
        std::cout << "Test voice response size: " << response.size() << std::endl;
        if (!response.empty()) {
            std::cout << "Response bytes: ";
            for (size_t i = 0; i < std::min(response.size(), size_t(16)); ++i) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(response[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
    }
    
    // Python: if cmd_response.get('status'):
    if (response.empty()) {
        if (verbose_) std::cout << "Test voice failed - no response" << std::endl;
        return false;
    }
    
    // Check response status
    if (response.size() >= 2) {
        uint16_t responseCode = (response[1] << 8) | response[0];
        if (verbose_) std::cout << "Response code: " << responseCode << std::endl;
        
        // Accept multiple success codes
        if (responseCode != ZKTecoConstants::CMD_ACK_OK && 
            responseCode != ZKTecoConstants::CMD_ACK_DATA &&
            responseCode != 2007) {
            if (verbose_) std::cout << "Test voice failed with response code: " << responseCode << std::endl;
            return false;
        }
    }
    
    if (verbose_) std::cout << "Voice test executed successfully" << std::endl;
    return true;
}

bool ZKTecoDevice::GetLockState() {
    if (verbose_) {
        std::cout << "Getting lock state" << std::endl;
    }
    
    // Python: command = const.CMD_DOORSTATE_RRQ
    uint16_t command = ZKTecoConstants::CMD_DOORSTATE_RRQ;
    
    // Python: cmd_response = self.__send_command(command)
    std::vector<uint8_t> response;
    if (!SendCommand(command, std::vector<uint8_t>{}, 8, &response, "GetLockState")) {
        if (verbose_) std::cout << "Failed to send get lock state command" << std::endl;
        return false;
    }
    
    if (verbose_) {
        std::cout << "Get lock state response size: " << response.size() << std::endl;
        if (!response.empty()) {
            std::cout << "Response bytes: ";
            for (size_t i = 0; i < std::min(response.size(), size_t(16)); ++i) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(response[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
    }
    
    // Python: if cmd_response.get('status'):
    if (response.empty()) {
        if (verbose_) std::cout << "Get lock state failed - no response" << std::endl;
        return false;
    }
    
    // Check response status
    if (response.size() >= 2) {
        uint16_t responseCode = (response[1] << 8) | response[0];
        if (verbose_) std::cout << "Response code: " << responseCode << std::endl;
        
        // Accept multiple success codes
        if (responseCode != ZKTecoConstants::CMD_ACK_OK && 
            responseCode != ZKTecoConstants::CMD_ACK_DATA &&
            responseCode != 2007) {
            if (verbose_) std::cout << "Get lock state failed with response code: " << responseCode << std::endl;
            return false;
        }
    }
    
    if (verbose_) std::cout << "Lock state retrieved successfully" << std::endl;
    return true;
}

bool ZKTecoDevice::Restart() {
    if (verbose_) {
        std::cout << "Restarting device" << std::endl;
    }
    
    // Python: command = const.CMD_RESTART
    uint16_t command = ZKTecoConstants::CMD_RESTART;
    
    // Python: cmd_response = self.__send_command(command)
    std::vector<uint8_t> response;
    if (!SendCommand(command, std::vector<uint8_t>{}, 8, &response, "Restart")) {
        if (verbose_) std::cout << "Failed to send restart command" << std::endl;
        return false;
    }
    
    if (verbose_) {
        std::cout << "Restart response size: " << response.size() << std::endl;
        if (!response.empty()) {
            std::cout << "Response bytes: ";
            for (size_t i = 0; i < std::min(response.size(), size_t(16)); ++i) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(response[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
    }
    
    // Python: if cmd_response.get('status'):
    if (response.empty()) {
        if (verbose_) std::cout << "Restart failed - no response" << std::endl;
        return false;
    }
    
    // Check response status
    if (response.size() >= 2) {
        uint16_t responseCode = (response[1] << 8) | response[0];
        if (verbose_) std::cout << "Response code: " << responseCode << std::endl;
        
        // Accept multiple success codes
        if (responseCode != ZKTecoConstants::CMD_ACK_OK && 
            responseCode != ZKTecoConstants::CMD_ACK_DATA &&
            responseCode != 2007) {
            if (verbose_) std::cout << "Restart failed with response code: " << responseCode << std::endl;
            return false;
        }
    }
    
    // Python: self.is_connect = False
    // Python: self.next_uid = 1
    // Note: In C++, we don't need to reset these as the device will disconnect anyway
    
    if (verbose_) std::cout << "Device restart initiated successfully" << std::endl;
    return true;
}

bool ZKTecoDevice::Unlock(int time) {
    if (verbose_) {
        std::cout << "Unlocking door for " << time << " seconds" << std::endl;
    }
    
    // Python: command = const.CMD_UNLOCK
    uint16_t command = ZKTecoConstants::CMD_UNLOCK;
    
    // Python: command_string = pack("I",int(time)*10)
    std::vector<uint8_t> commandString;
    int timeValue = time * 10; // Convert seconds to device time units
    commandString.push_back(timeValue & 0xFF);
    commandString.push_back((timeValue >> 8) & 0xFF);
    commandString.push_back((timeValue >> 16) & 0xFF);
    commandString.push_back((timeValue >> 24) & 0xFF);
    
    // Python: cmd_response = self.__send_command(command, command_string)
    std::vector<uint8_t> response;
    if (!SendCommand(command, commandString, 8, &response, "Unlock")) {
        if (verbose_) std::cout << "Failed to send unlock command" << std::endl;
        return false;
    }
    
    if (verbose_) {
        std::cout << "Unlock response size: " << response.size() << std::endl;
        if (!response.empty()) {
            std::cout << "Response bytes: ";
            for (size_t i = 0; i < std::min(response.size(), size_t(16)); ++i) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(response[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
    }
    
    // Python: if cmd_response.get('status'):
    if (response.empty()) {
        if (verbose_) std::cout << "Unlock failed - no response" << std::endl;
        return false;
    }
    
    // Check response status
    if (response.size() >= 2) {
        uint16_t responseCode = (response[1] << 8) | response[0];
        if (verbose_) std::cout << "Response code: " << responseCode << std::endl;
        
        // Accept multiple success codes
        if (responseCode != ZKTecoConstants::CMD_ACK_OK && 
            responseCode != ZKTecoConstants::CMD_ACK_DATA &&
            responseCode != 2007) {
            if (verbose_) std::cout << "Unlock failed with response code: " << responseCode << std::endl;
            return false;
        }
    }
    
    if (verbose_) std::cout << "Door unlocked successfully for " << time << " seconds" << std::endl;
    return true;
}

bool ZKTecoDevice::EnableDevice() {
    if (verbose_) {
        std::cout << "Enabling device" << std::endl;
    }
    
    // Python: cmd_response = self.__send_command(const.CMD_ENABLEDEVICE)
    uint16_t command = ZKTecoConstants::CMD_ENABLEDEVICE;
    
    std::vector<uint8_t> response;
    if (!SendCommand(command, {}, 8, &response, "EnableDevice")) {
        if (verbose_) std::cout << "Failed to send enable device command" << std::endl;
        return false;
    }
    
    if (verbose_) {
        std::cout << "Enable device response size: " << response.size() << std::endl;
        if (!response.empty()) {
            std::cout << "Response bytes: ";
            for (size_t i = 0; i < std::min(response.size(), size_t(16)); ++i) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(response[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
    }
    
    // Python: if cmd_response.get('status'):
    if (response.empty()) {
        if (verbose_) std::cout << "Enable device failed - no response" << std::endl;
        return false;
    }
    
    // Check response status
    if (response.size() >= 2) {
        uint16_t responseCode = (response[1] << 8) | response[0];
        if (verbose_) std::cout << "Response code: " << responseCode << std::endl;
        
        // Accept multiple success codes
        if (responseCode != ZKTecoConstants::CMD_ACK_OK && 
            responseCode != ZKTecoConstants::CMD_ACK_DATA &&
            responseCode != 2007) {
            if (verbose_) std::cout << "Enable device failed with response code: " << responseCode << std::endl;
            return false;
        }
    }
    
    if (verbose_) std::cout << "Device enabled successfully" << std::endl;
    return true;
}

bool ZKTecoDevice::DisableDevice() {
    if (verbose_) {
        std::cout << "Disabling device" << std::endl;
    }
    
    // Python: cmd_response = self.__send_command(const.CMD_DISABLEDEVICE)
    uint16_t command = ZKTecoConstants::CMD_DISABLEDEVICE;
    
    std::vector<uint8_t> response;
    if (!SendCommand(command, {}, 8, &response, "DisableDevice")) {
        if (verbose_) std::cout << "Failed to send disable device command" << std::endl;
        return false;
    }
    
    if (verbose_) {
        std::cout << "Disable device response size: " << response.size() << std::endl;
        if (!response.empty()) {
            std::cout << "Response bytes: ";
            for (size_t i = 0; i < std::min(response.size(), size_t(16)); ++i) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(response[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
    }
    
    // Python: if cmd_response.get('status'):
    if (response.empty()) {
        if (verbose_) std::cout << "Disable device failed - no response" << std::endl;
        return false;
    }
    
    // Check response status
    if (response.size() >= 2) {
        uint16_t responseCode = (response[1] << 8) | response[0];
        if (verbose_) std::cout << "Response code: " << responseCode << std::endl;
        
        // Accept multiple success codes
        if (responseCode != ZKTecoConstants::CMD_ACK_OK && 
            responseCode != ZKTecoConstants::CMD_ACK_DATA &&
            responseCode != 2007) {
            if (verbose_) std::cout << "Disable device failed with response code: " << responseCode << std::endl;
            return false;
        }
    }
    
    if (verbose_) std::cout << "Device disabled successfully" << std::endl;
    return true;
}

bool ZKTecoDevice::SetTime(time_t timestamp) {
    if (verbose_) {
        std::cout << "Setting device time to timestamp: " << timestamp << std::endl;
    }
    
    // Python: command = const.CMD_SET_TIME
    uint16_t command = ZKTecoConstants::CMD_SET_TIME;
    
    // Python: command_string = pack(b'I', self.__encode_time(timestamp))
    // First convert timestamp to datetime components
    struct tm* timeinfo = localtime(&timestamp);
    if (!timeinfo) {
        if (verbose_) std::cout << "Failed to convert timestamp to time components" << std::endl;
        return false;
    }
    
    // Python __encode_time formula:
    // d = (((t.year % 100) * 12 * 31 + ((t.month - 1) * 31) + t.day - 1) * (24 * 60 * 60) + (t.hour * 60 + t.minute) * 60 + t.second)
    int year = timeinfo->tm_year + 1900; // tm_year is years since 1900
    int month = timeinfo->tm_mon + 1;    // tm_mon is 0-based
    int day = timeinfo->tm_mday;
    int hour = timeinfo->tm_hour;
    int minute = timeinfo->tm_min;
    int second = timeinfo->tm_sec;
    
    // Calculate encoded time value
    uint32_t encodedTime = (
        (((year % 100) * 12 * 31 + ((month - 1) * 31) + day - 1) * 
         (24 * 60 * 60)) + 
        (hour * 60 + minute) * 60 + second
    );
    
    if (verbose_) {
        std::cout << "Time components: " << year << "-" << month << "-" << day 
                  << " " << hour << ":" << minute << ":" << second << std::endl;
        std::cout << "Encoded time value: " << encodedTime << std::endl;
    }
    
    // Pack encoded time as 4-byte little-endian integer
    std::vector<uint8_t> commandString;
    commandString.push_back(encodedTime & 0xFF);
    commandString.push_back((encodedTime >> 8) & 0xFF);
    commandString.push_back((encodedTime >> 16) & 0xFF);
    commandString.push_back((encodedTime >> 24) & 0xFF);
    
    // Python: cmd_response = self.__send_command(command, command_string)
    std::vector<uint8_t> response;
    if (!SendCommand(command, commandString, 8, &response, "SetTime")) {
        if (verbose_) std::cout << "Failed to send set time command" << std::endl;
        return false;
    }
    
    if (verbose_) {
        std::cout << "Set time response size: " << response.size() << std::endl;
        if (!response.empty()) {
            std::cout << "Response bytes: ";
            for (size_t i = 0; i < std::min(response.size(), size_t(16)); ++i) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(response[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
    }
    
    // Python: if cmd_response.get('status'):
    if (response.empty()) {
        if (verbose_) std::cout << "Set time failed - no response" << std::endl;
        return false;
    }
    
    // Check response status
    if (response.size() >= 2) {
        uint16_t responseCode = (response[1] << 8) | response[0];
        if (verbose_) std::cout << "Response code: " << responseCode << std::endl;
        
        // Accept multiple success codes
        if (responseCode != ZKTecoConstants::CMD_ACK_OK && 
            responseCode != ZKTecoConstants::CMD_ACK_DATA &&
            responseCode != 2007) {
            if (verbose_) std::cout << "Set time failed with response code: " << responseCode << std::endl;
            return false;
        }
    }
    
    if (verbose_) std::cout << "Device time set successfully" << std::endl;
    return true;
}

bool ZKTecoDevice::SetDeviceName(const std::string& deviceName) {
    if (verbose_) {
        std::cout << "Setting device name to: " << deviceName << std::endl;
    }
    
    // Use CMD_OPTIONS_WRQ for writing device options
    uint16_t command = ZKTecoConstants::CMD_OPTIONS_WRQ;
    
    // Format: "~DeviceName=NewName\0"
    std::string commandString = "~DeviceName=" + deviceName;
    commandString.push_back('\0'); // Add null terminator
    
    if (verbose_) {
        std::cout << "Command string: " << commandString << std::endl;
    }
    
    // Convert string to vector of bytes
    std::vector<uint8_t> cmdBytes(commandString.begin(), commandString.end());
    
    // Send command to device
    std::vector<uint8_t> response;
    if (!SendCommand(command, cmdBytes, 8, &response, "SetDeviceName")) {
        if (verbose_) std::cout << "Failed to send set device name command" << std::endl;
        return false;
    }
    
    if (verbose_) {
        std::cout << "Set device name response size: " << response.size() << std::endl;
        if (!response.empty()) {
            std::cout << "Response bytes: ";
            for (size_t i = 0; i < std::min(response.size(), size_t(16)); ++i) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(response[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
    }
    
    // Check response status
    if (response.empty()) {
        if (verbose_) std::cout << "Set device name failed - no response" << std::endl;
        return false;
    }
    
    // Check response status
    if (response.size() >= 2) {
        uint16_t responseCode = (response[1] << 8) | response[0];
        if (verbose_) std::cout << "Response code: " << responseCode << std::endl;
        
        // Accept multiple success codes
        if (responseCode != ZKTecoConstants::CMD_ACK_OK && 
            responseCode != ZKTecoConstants::CMD_ACK_DATA &&
            responseCode != 2007) {
            if (verbose_) std::cout << "Set device name failed with response code: " << responseCode << std::endl;
            return false;
        }
    }
    
    if (verbose_) std::cout << "Device name set successfully" << std::endl;
    return true;
}

// Live capture functionality
bool ZKTecoDevice::StartLiveCapture(int timeout) {
    if (!isConnected_) {
        if (verbose_) std::cout << "Device not connected" << std::endl;
        return false;
    }
    
    if (liveCaptureActive_) {
        if (verbose_) std::cout << "Live capture already active" << std::endl;
        return true;
    }
    
    try {
        // Store timeout
        liveCaptureTimeout_ = timeout;
        
        // Get current device enable state
        wasEnabledBeforeLiveCapture_ = true; // Assume enabled, we can check this if needed
        
        // Get users for live capture
        liveCaptureUsers_ = GetUsers();
        if (verbose_) std::cout << "Live capture loaded " << liveCaptureUsers_.size() << " users" << std::endl;
        
        // Clear event buffers
        liveEventBuffer_.clear();
        while (!eventQueue_.empty()) eventQueue_.pop();
        
        // Cancel any ongoing capture
        std::vector<uint8_t> empty;
        SendCommand(ZKTecoConstants::CMD_CANCELCAPTURE, empty, 8, nullptr, "StartLiveCapture::cancel");
        
        // Start verify mode
        SendCommand(ZKTecoConstants::CMD_STARTVERIFY, empty, 8, nullptr, "StartLiveCapture::verify");
        
        // Enable device if not enabled
        EnableDevice();
        
        // Register for attendance events
        std::vector<uint8_t> eventData(4);
        uint32_t eventFlag = ZKTecoConstants::EF_ATTLOG;
        eventData[0] = eventFlag & 0xFF;
        eventData[1] = (eventFlag >> 8) & 0xFF;
        eventData[2] = (eventFlag >> 16) & 0xFF;
        eventData[3] = (eventFlag >> 24) & 0xFF;
        
        if (!SendCommand(ZKTecoConstants::CMD_REG_EVENT, eventData, 8, nullptr, "StartLiveCapture::reg")) {
            if (verbose_) std::cout << "Failed to register for events" << std::endl;
            return false;
        }
        
        // Flush any existing events from device buffer before starting
        FlushExistingEvents();
        
        // Small delay to let device stabilize after flush
        Sleep(500); // 500ms delay
        
        // Set socket to non-blocking mode for live capture
        u_long mode = 1; // 1 to enable non-blocking socket
        if (ioctlsocket(socket_, FIONBIO, &mode) != 0) {
            if (verbose_) std::cout << "Failed to set socket to non-blocking mode" << std::endl;
        }
        
        liveCaptureActive_ = true;
        if (verbose_) std::cout << "Live capture started successfully" << std::endl;
        return true;
        
    } catch (const std::exception& e) {
        if (verbose_) std::cout << "Error starting live capture: " << e.what() << std::endl;
        return false;
    }
}

ZKTecoAttendance ZKTecoDevice::GetNextLiveEvent() {
    if (!liveCaptureActive_ || !isConnected_) {
        return ZKTecoAttendance(); // Return empty attendance
    }
    
    // First, check if we have events in the queue
    if (!eventQueue_.empty()) {
        ZKTecoAttendance event = eventQueue_.front();
        eventQueue_.pop();
        if (verbose_) std::cout << "Returning queued event" << std::endl;
        return event;
    }
    
    try {
        // Try to receive new data (non-blocking)
        std::vector<uint8_t> buffer(1032);
        int received = recv(socket_, reinterpret_cast<char*>(buffer.data()), static_cast<int>(buffer.size()), 0);
        
        if (received <= 0) {
            int error = WSAGetLastError();
            if (error == WSAEWOULDBLOCK) {
                // No data available right now - this is normal for non-blocking sockets
                return ZKTecoAttendance();
            } else {
                // Actual error - return empty attendance
                if (verbose_) std::cout << "Socket receive error: " << error << std::endl;
                return ZKTecoAttendance();
            }
        }
        
        buffer.resize(received);
        
        // DEBUG: Print raw received data
        if (verbose_) {
            std::cout << "=== LIVE EVENT RAW DATA ===" << std::endl;
            std::cout << "Received " << received << " bytes:" << std::endl;
            std::cout << "Raw hex: ";
            for (int i = 0; i < received; i++) {
                std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(buffer[i]) << " ";
            }
            std::cout << std::dec << std::endl;
        }
        
        // Parse the received data first to get header for ACK
        std::vector<uint8_t> header;
        std::vector<uint8_t> data;
        
        if (!forceUdp_) { // TCP
            if (received < 16) return ZKTecoAttendance();
            
            // Extract header (skip size field)
            header.assign(buffer.begin() + 8, buffer.begin() + 16);
            data.assign(buffer.begin() + 16, buffer.end());
        } else { // UDP
            if (received < 8) return ZKTecoAttendance();
            
            header.assign(buffer.begin(), buffer.begin() + 8);
            data.assign(buffer.begin() + 8, buffer.end());
        }
        
        // Send ACK (send-only, no response expected) - use session/reply from received header
        SendAckOnly(header);
        
        // Check if this is an event
        uint16_t command = header[0] | (header[1] << 8);
        if (verbose_) {
            std::cout << "Command: 0x" << std::hex << command << std::dec << " (CMD_REG_EVENT = 0x" << std::hex << ZKTecoConstants::CMD_REG_EVENT << std::dec << ")" << std::endl;
        }
        
        if (command != ZKTecoConstants::CMD_REG_EVENT) {
            if (verbose_) std::cout << "Not an event, command: " << std::hex << command << std::dec << std::endl;
            return ZKTecoAttendance();
        }
        
        if (data.empty()) {
            if (verbose_) std::cout << "Empty event data" << std::endl;
            return ZKTecoAttendance();
        }
        
        // Append new data to buffer
        liveEventBuffer_.insert(liveEventBuffer_.end(), data.begin(), data.end());
        
        // Process all complete events in buffer (like Python's while loop)
        ProcessEventBuffer();
        
        // Return the first event from queue if available
        if (!eventQueue_.empty()) {
            ZKTecoAttendance event = eventQueue_.front();
            eventQueue_.pop();
            return event;
        }
        
        return ZKTecoAttendance();
        
    } catch (const std::exception& e) {
        if (verbose_) std::cout << "Error getting next live event: " << e.what() << std::endl;
        return ZKTecoAttendance();
    }
}

ZKTecoAttendance ZKTecoDevice::ParseLiveEventData(const std::vector<uint8_t>& data) {
    if (verbose_) {
        std::cout << "=== PARSING LIVE EVENT DATA ===" << std::endl;
        std::cout << "Data size: " << data.size() << " bytes" << std::endl;
        std::cout << "Raw event data: ";
        for (size_t i = 0; i < data.size(); i++) {
            std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(data[i]) << " ";
        }
        std::cout << std::dec << std::endl;
    }
    
    if (data.size() < 10) {
        if (verbose_) std::cout << "Data too small (< 10 bytes), returning empty" << std::endl;
        return ZKTecoAttendance();
    }
    
    std::vector<uint8_t> eventData = data;
    
    // Parse based on data length (following Python implementation)
    std::string userId;
    uint8_t status = 0;
    uint8_t punch = 0;
    std::vector<uint8_t> timeHex;
    int uid = 0;
    
    if (eventData.size() >= 10) {
        if (eventData.size() == 10) {
            if (verbose_) std::cout << "Using 10-byte format: user_id(2), status(1), punch(1), timehex(6)" << std::endl;
            
            uint16_t userIdInt = eventData[0] | (eventData[1] << 8);
            userId = std::to_string(userIdInt);
            status = eventData[2];
            punch = eventData[3];
            timeHex.assign(eventData.begin() + 4, eventData.begin() + 10);
            
            if (verbose_) {
                std::cout << "  Raw userIdInt bytes: " << std::hex << static_cast<int>(eventData[0]) << " " << static_cast<int>(eventData[1]) << std::dec << std::endl;
                std::cout << "  Parsed userIdInt: " << userIdInt << std::endl;
                std::cout << "  Status: " << static_cast<int>(status) << std::endl;
                std::cout << "  Punch: " << static_cast<int>(punch) << std::endl;
                std::cout << "  TimeHex: ";
                for (size_t i = 0; i < timeHex.size(); i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(timeHex[i]) << " ";
                }
                std::cout << std::dec << std::endl;
            }
        } else if (eventData.size() == 12) {
            if (verbose_) std::cout << "Using 12-byte format: user_id(4), status(1), punch(1), timehex(6)" << std::endl;
            
            uint32_t userIdInt = eventData[0] | (eventData[1] << 8) | (eventData[2] << 16) | (eventData[3] << 24);
            userId = std::to_string(userIdInt);
            status = eventData[4];
            punch = eventData[5];
            timeHex.assign(eventData.begin() + 6, eventData.begin() + 12);
            
            if (verbose_) {
                std::cout << "  Raw userIdInt bytes: " << std::hex << static_cast<int>(eventData[0]) << " " << static_cast<int>(eventData[1]) << " " << static_cast<int>(eventData[2]) << " " << static_cast<int>(eventData[3]) << std::dec << std::endl;
                std::cout << "  Parsed userIdInt: " << userIdInt << std::endl;
                std::cout << "  Status: " << static_cast<int>(status) << std::endl;
                std::cout << "  Punch: " << static_cast<int>(punch) << std::endl;
                std::cout << "  TimeHex: ";
                for (size_t i = 0; i < timeHex.size(); i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(timeHex[i]) << " ";
                }
                std::cout << std::dec << std::endl;
            }
        } else if (eventData.size() == 14) {
            if (verbose_) std::cout << "Using 14-byte format: user_id(2), status(1), punch(1), timehex(6), other(4)" << std::endl;
            
            uint16_t userIdInt = eventData[0] | (eventData[1] << 8);
            userId = std::to_string(userIdInt);
            status = eventData[2];
            punch = eventData[3];
            timeHex.assign(eventData.begin() + 4, eventData.begin() + 10);
            
            if (verbose_) {
                std::cout << "  Raw userIdInt bytes: " << std::hex << static_cast<int>(eventData[0]) << " " << static_cast<int>(eventData[1]) << std::dec << std::endl;
                std::cout << "  Parsed userIdInt: " << userIdInt << std::endl;
                std::cout << "  Status: " << static_cast<int>(status) << std::endl;
                std::cout << "  Punch: " << static_cast<int>(punch) << std::endl;
                std::cout << "  TimeHex: ";
                for (size_t i = 0; i < timeHex.size(); i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(timeHex[i]) << " ";
                }
                std::cout << std::dec << std::endl;
            }
        } else if (eventData.size() == 32) {
            if (verbose_) std::cout << "Using 32-byte format: user_id(24), status(1), punch(1), timehex(6)" << std::endl;
            
            // Extract user_id (24 bytes, null-terminated)
            for (int i = 0; i < 24; i++) {
                if (eventData[i] != 0) {
                    userId += static_cast<char>(eventData[i]);
                } else {
                    break;
                }
            }
            status = eventData[24];
            punch = eventData[25];
            timeHex.assign(eventData.begin() + 26, eventData.begin() + 32);
            
            if (verbose_) {
                std::cout << "  Raw userId string bytes: ";
                for (int i = 0; i < 24; i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(eventData[i]) << " ";
                }
                std::cout << std::dec << std::endl;
                std::cout << "  Parsed userId: '" << userId << "'" << std::endl;
                std::cout << "  Status: " << static_cast<int>(status) << std::endl;
                std::cout << "  Punch: " << static_cast<int>(punch) << std::endl;
                std::cout << "  TimeHex: ";
                for (size_t i = 0; i < timeHex.size(); i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(timeHex[i]) << " ";
                }
                std::cout << std::dec << std::endl;
            }
        } else if (eventData.size() == 36) {
            if (verbose_) std::cout << "Using 36-byte format: user_id(24), status(1), punch(1), timehex(6), other(4)" << std::endl;
            
            // Extract user_id (24 bytes, null-terminated)
            for (int i = 0; i < 24; i++) {
                if (eventData[i] != 0) {
                    userId += static_cast<char>(eventData[i]);
                } else {
                    break;
                }
            }
            status = eventData[24];
            punch = eventData[25];
            timeHex.assign(eventData.begin() + 26, eventData.begin() + 32);
            
            if (verbose_) {
                std::cout << "  Raw userId string bytes: ";
                for (int i = 0; i < 24; i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(eventData[i]) << " ";
                }
                std::cout << std::dec << std::endl;
                std::cout << "  Parsed userId: '" << userId << "'" << std::endl;
                std::cout << "  Status: " << static_cast<int>(status) << std::endl;
                std::cout << "  Punch: " << static_cast<int>(punch) << std::endl;
                std::cout << "  TimeHex: ";
                for (size_t i = 0; i < timeHex.size(); i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(timeHex[i]) << " ";
                }
                std::cout << std::dec << std::endl;
            }
        } else if (eventData.size() == 37) {
            if (verbose_) std::cout << "Using 37-byte format: user_id(24), status(1), punch(1), timehex(6), other(5)" << std::endl;
            
            // Extract user_id (24 bytes, null-terminated)
            for (int i = 0; i < 24; i++) {
                if (eventData[i] != 0) {
                    userId += static_cast<char>(eventData[i]);
                } else {
                    break;
                }
            }
            status = eventData[24];
            punch = eventData[25];
            timeHex.assign(eventData.begin() + 26, eventData.begin() + 32);
            
            if (verbose_) {
                std::cout << "  Raw userId string bytes: ";
                for (int i = 0; i < 24; i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(eventData[i]) << " ";
                }
                std::cout << std::dec << std::endl;
                std::cout << "  Parsed userId: '" << userId << "'" << std::endl;
                std::cout << "  Status: " << static_cast<int>(status) << std::endl;
                std::cout << "  Punch: " << static_cast<int>(punch) << std::endl;
                std::cout << "  TimeHex: ";
                for (size_t i = 0; i < timeHex.size(); i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(timeHex[i]) << " ";
                }
                std::cout << std::dec << std::endl;
            }
        } else if (eventData.size() >= 52) {
            if (verbose_) std::cout << "Using 52+ byte format: user_id(24), status(1), punch(1), timehex(6), other(20+)" << std::endl;
            
            // Extract user_id (24 bytes, null-terminated)
            for (int i = 0; i < 24; i++) {
                if (eventData[i] != 0) {
                    userId += static_cast<char>(eventData[i]);
                } else {
                    break;
                }
            }
            status = eventData[24];
            punch = eventData[25];
            timeHex.assign(eventData.begin() + 26, eventData.begin() + 32);
            
            if (verbose_) {
                std::cout << "  Raw userId string bytes: ";
                for (int i = 0; i < 24; i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(eventData[i]) << " ";
                }
                std::cout << std::dec << std::endl;
                std::cout << "  Parsed userId: '" << userId << "'" << std::endl;
                std::cout << "  Status: " << static_cast<int>(status) << std::endl;
                std::cout << "  Punch: " << static_cast<int>(punch) << std::endl;
                std::cout << "  TimeHex: ";
                for (size_t i = 0; i < timeHex.size(); i++) {
                    std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(timeHex[i]) << " ";
                }
                std::cout << std::dec << std::endl;
            }
        } else {
            if (verbose_) std::cout << "Unexpected data size: " << eventData.size() << " bytes (no parsing rule)" << std::endl;
        }
    }
    
    if (timeHex.size() < 6) {
        if (verbose_) std::cout << "TimeHex too small (< 6 bytes): " << timeHex.size() << std::endl;
        return ZKTecoAttendance();
    }
    
    // Decode timestamp using timehex format (6 bytes: year, month, day, hour, minute, second)
    std::string timestamp;
    uint8_t year = timeHex[0];
    uint8_t month = timeHex[1];
    uint8_t day = timeHex[2];
    uint8_t hour = timeHex[3];
    uint8_t minute = timeHex[4];
    uint8_t second = timeHex[5];
    
    // Year is offset from 2000
    int fullYear = 2000 + year;
    
    if (verbose_) {
        std::cout << "TimeHex decoding (6 bytes): ";
        for (size_t i = 0; i < 6; i++) {
            std::cout << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(timeHex[i]) << " ";
        }
        std::cout << std::dec << std::endl;
        std::cout << "  Year: " << static_cast<int>(year) << " -> " << fullYear << std::endl;
        std::cout << "  Month: " << static_cast<int>(month) << std::endl;
        std::cout << "  Day: " << static_cast<int>(day) << std::endl;
        std::cout << "  Hour: " << static_cast<int>(hour) << std::endl;
        std::cout << "  Minute: " << static_cast<int>(minute) << std::endl;
        std::cout << "  Second: " << static_cast<int>(second) << std::endl;
    }
    
    // Validate date components
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && 
        hour < 24 && minute < 60 && second < 60) {
        char timeStr[32];
        snprintf(timeStr, sizeof(timeStr), "%04d-%02d-%02dT%02d:%02d:%02d",
                 fullYear, month, day, hour, minute, second);
        timestamp = std::string(timeStr);
    } else {
        if (verbose_) std::cout << "Invalid timestamp components, using default" << std::endl;
        timestamp = "2000-01-01T00:00:00";
    }
    
    if (verbose_) {
        std::cout << "Final timestamp: '" << timestamp << "'" << std::endl;
    }
    
    // Find corresponding user to get UID
    if (verbose_) {
        std::cout << "=== USER LOOKUP ===" << std::endl;
        std::cout << "Looking for userId: '" << userId << "'" << std::endl;
        std::cout << "Available users in liveCaptureUsers_:" << std::endl;
        for (const auto& user : liveCaptureUsers_) {
            std::cout << "  User: uid=" << user.GetUid() << ", userId='" << user.GetUserId() << "', name='" << user.GetName() << "'" << std::endl;
        }
    }
    
    for (const auto& user : liveCaptureUsers_) {
        if (user.GetUserId() == userId) {
            uid = user.GetUid();
            if (verbose_) std::cout << "Found matching user: userId='" << userId << "' -> uid=" << uid << std::endl;
            break;
        }
    }
    
    // If no user found, try to parse userId as UID
    if (uid == 0) {
        try {
            uid = std::stoi(userId);
            if (verbose_) std::cout << "No user found, using userId as uid: '" << userId << "' -> uid=" << uid << std::endl;
        } catch (...) {
            uid = 0;
            if (verbose_) std::cout << "Could not parse userId as uid, defaulting to 0" << std::endl;
        }
    }
    
    if (verbose_) {
        std::cout << "=== FINAL PARSED RESULT ===" << std::endl;
        std::cout << "userId: '" << userId << "'" << std::endl;
        std::cout << "uid: " << uid << std::endl;
        std::cout << "status: " << static_cast<int>(status) << std::endl;
        std::cout << "punch: " << static_cast<int>(punch) << std::endl;
        std::cout << "timestamp: '" << timestamp << "'" << std::endl;
        std::cout << "=========================" << std::endl;
    }
    
    return ZKTecoAttendance(userId, timestamp, status, punch, uid);
}

void ZKTecoDevice::ProcessEventBuffer() {
    if (verbose_) {
        std::cout << "=== PROCESSING EVENT BUFFER ===" << std::endl;
        std::cout << "Buffer size: " << liveEventBuffer_.size() << " bytes" << std::endl;
    }
    
    // Process all complete events in buffer (mimic Python's while loop)
    while (liveEventBuffer_.size() >= 10) {
        size_t eventSize = 0;
        
        // Determine event size based on buffer length (following Python logic)
        if (liveEventBuffer_.size() == 10) {
            eventSize = 10;
        } else if (liveEventBuffer_.size() == 12) {
            eventSize = 12;
        } else if (liveEventBuffer_.size() == 14) {
            eventSize = 14;
        } else if (liveEventBuffer_.size() == 32) {
            eventSize = 32;
        } else if (liveEventBuffer_.size() == 36) {
            eventSize = 36;
        } else if (liveEventBuffer_.size() == 37) {
            eventSize = 37;
        } else if (liveEventBuffer_.size() >= 52) {
            eventSize = 52;
        } else {
            // For other sizes, try to process as much as we can
            // Start with smallest possible event size
            if (liveEventBuffer_.size() >= 52) {
                eventSize = 52;
            } else if (liveEventBuffer_.size() >= 37) {
                eventSize = 37;
            } else if (liveEventBuffer_.size() >= 36) {
                eventSize = 36;
            } else if (liveEventBuffer_.size() >= 32) {
                eventSize = 32;
            } else if (liveEventBuffer_.size() >= 14) {
                eventSize = 14;
            } else if (liveEventBuffer_.size() >= 12) {
                eventSize = 12;
            } else if (liveEventBuffer_.size() >= 10) {
                eventSize = 10;
            } else {
                break; // Not enough data for any event
            }
        }
        
        if (verbose_) {
            std::cout << "Processing event of size " << eventSize << " bytes" << std::endl;
        }
        
        // Extract event data
        std::vector<uint8_t> eventData(liveEventBuffer_.begin(), liveEventBuffer_.begin() + eventSize);
        
        // Parse the event
        ZKTecoAttendance attendance = ParseLiveEventData(eventData);
        
        // Add to queue if valid
        if (!attendance.GetUserId().empty()) {
            eventQueue_.push(attendance);
            if (verbose_) std::cout << "Added event to queue" << std::endl;
        }
        
        // Remove processed bytes from buffer
        liveEventBuffer_.erase(liveEventBuffer_.begin(), liveEventBuffer_.begin() + eventSize);
        
        if (verbose_) {
            std::cout << "Remaining buffer size: " << liveEventBuffer_.size() << " bytes" << std::endl;
        }
    }
    
    if (verbose_) {
        std::cout << "Event queue now has " << eventQueue_.size() << " events" << std::endl;
        std::cout << "===============================" << std::endl;
    }
}

void ZKTecoDevice::FlushExistingEvents() {
    if (verbose_) std::cout << "Flushing existing events from device buffer..." << std::endl;
    
    try {
        // Temporarily set socket to blocking mode with short timeout
        u_long mode = 0; // blocking mode
        ioctlsocket(socket_, FIONBIO, &mode);
        
        // Set a short timeout to flush events quickly
        DWORD timeout = 1000; // 1 second timeout
        setsockopt(socket_, SOL_SOCKET, SO_RCVTIMEO, (const char*)&timeout, sizeof(timeout));
        
        int flushCount = 0;
        std::vector<uint8_t> buffer(1032);
        
        // Keep receiving until no more data or timeout
        while (flushCount < 10) { // Limit to prevent infinite loop
            int received = recv(socket_, reinterpret_cast<char*>(buffer.data()), static_cast<int>(buffer.size()), 0);
            
            if (received <= 0) {
                int error = WSAGetLastError();
                if (error == WSAETIMEDOUT || error == WSAEWOULDBLOCK) {
                    // No more data - good!
                    break;
                } else {
                    // Some other error
                    if (verbose_) std::cout << "Flush error: " << error << std::endl;
                    break;
                }
            } else {
                flushCount++;
                if (verbose_) {
                    std::cout << "Flushed " << received << " bytes of old event data" << std::endl;
                    
                    // Parse and show what we're flushing
                    if (received >= 16 && !forceUdp_) {
                        std::vector<uint8_t> header(buffer.begin() + 8, buffer.begin() + 16);
                        uint16_t command = header[0] | (header[1] << 8);
                        if (command == ZKTecoConstants::CMD_REG_EVENT) {
                            std::cout << "  -> Flushed old attendance event" << std::endl;
                        }
                        
                        // Send ACK for flushed events using the received header
                        SendAckOnly(header);
                    } else if (received >= 8 && forceUdp_) {
                        std::vector<uint8_t> header(buffer.begin(), buffer.begin() + 8);
                        SendAckOnly(header);
                    } else {
                        // Send generic ACK if header is incomplete
                        SendAckOnly();
                    }
                } else {
                    // Send generic ACK if no debugging
                    if (received >= 16 && !forceUdp_) {
                        std::vector<uint8_t> header(buffer.begin() + 8, buffer.begin() + 16);
                        SendAckOnly(header);
                    } else if (received >= 8 && forceUdp_) {
                        std::vector<uint8_t> header(buffer.begin(), buffer.begin() + 8);
                        SendAckOnly(header);
                    } else {
                        SendAckOnly();
                    }
                }
            }
        }
        
        if (verbose_) std::cout << "Flushed " << flushCount << " old event packets" << std::endl;
        
        // Reset timeout to original
        timeout = timeout_ * 1000; // Convert to milliseconds
        setsockopt(socket_, SOL_SOCKET, SO_RCVTIMEO, (const char*)&timeout, sizeof(timeout));
        
    } catch (const std::exception& e) {
        if (verbose_) std::cout << "Error during flush: " << e.what() << std::endl;
    }
}

bool ZKTecoDevice::StopLiveCapture() {
    if (!liveCaptureActive_) {
        return true;
    }
    
    try {
        // Reset socket to blocking mode
        u_long mode = 0; // 0 to disable non-blocking socket
        if (ioctlsocket(socket_, FIONBIO, &mode) != 0) {
            if (verbose_) std::cout << "Failed to reset socket to blocking mode" << std::endl;
        }
        
        // Unregister events
        std::vector<uint8_t> eventData(4, 0); // All zeros to disable events
        SendCommand(ZKTecoConstants::CMD_REG_EVENT, eventData, 8, nullptr, "StopLiveCapture::unreg");
        
        // Restore device state if it was disabled before
        if (!wasEnabledBeforeLiveCapture_) {
            DisableDevice();
        }
        
        liveCaptureActive_ = false;
        liveCaptureUsers_.clear();
        
        // Clear event buffers
        liveEventBuffer_.clear();
        while (!eventQueue_.empty()) eventQueue_.pop();
        
        if (verbose_) std::cout << "Live capture stopped successfully" << std::endl;
        return true;
        
    } catch (const std::exception& e) {
        if (verbose_) std::cout << "Error stopping live capture: " << e.what() << std::endl;
        liveCaptureActive_ = false; // Force stop
        return false;
    }
}