import { ZKTeco } from './src/index.js';
async function test() {
    const zk = new ZKTeco('192.168.0.233', 4371, 5000, 69420, false, false); // verbose=false to reduce output
    try {
        console.log('Connecting...');
        const connected = await zk.connect();
        if (connected) {
            const attendance = await zk.getAttendance();
            console.log('\nAttendance records count:', attendance.length);
            if (attendance.length > 0) {
                console.log('\nFirst 5 attendance records:');
                for (let i = 0; i < Math.min(5, attendance.length); i++) {
                    const rec = attendance[i];
                    console.log(`  ${i + 1}. userId: ${rec.userId}, uid: ${rec.uid}, status: ${rec.status}, punch: ${rec.punch}, time: ${rec.timestamp}`);
                }
            }
            await zk.disconnect();
            console.log('\nDisconnected');
        }
    }
    catch (e) {
        console.error('Error:', e);
    }
}
test();
//# sourceMappingURL=test_attendance.js.map