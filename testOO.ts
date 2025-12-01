import { ZKTecoClient } from './src/index.js';

async function testLiveEvents() {
    const zk = new ZKTecoClient('192.168.0.233', 4371, 5000, 69420, false, true);

    try {
        console.log('Connecting...');
        const connected = await zk.connect();
        if (!connected) {
            console.error('Unable to connect to device');
            return;
        }
        console.log('Connected');

        const memory = await zk.getMemoryInfo();
        console.log('Memory Info:', memory);

        console.log('Starting live capture...');
        const started = await zk.startLiveCapture(2);
        if (!started) {
            console.error('Unable to start live capture');
            return;
        }

        const eventsToCollect = 5;
        const timeoutMs = 15000;
        const startTime = Date.now();
        let collected = 0;

        while (collected < eventsToCollect && Date.now() - startTime < timeoutMs) {
            const event = await zk.getNextLiveEvent();
            if (event) {
                collected++;
                console.log(`Live Event ${collected}:`, {
                    userId: event.userId,
                    uid: event.uid,
                    timestamp: event.timestamp,
                    status: event.status,
                    punch: event.punch
                });
            }
        }

        await zk.stopLiveCapture();
        console.log(`Live capture stopped after collecting ${collected} events`);
    } catch (error) {
        console.error('Live capture test failed:', error);
    } finally {
        await zk.disconnect();
        console.log('Disconnected');
    }
}

testLiveEvents();