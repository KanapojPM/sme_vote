// ตัวแปรสำหรับเก็บอินสแตนซ์ของ Chart.js
let votesChart = null;
let turnoutChart = null;

// ----------------------------------------------------
// เริ่มต้นการทำงานฝั่ง Admin Dashboard
// ----------------------------------------------------
let pollInterval = null;
let isSettingsLoaded = false;

window.onload = async function() {
    const password = sessionStorage.getItem('adminPassword');
    if (password) {
        document.getElementById('admin-login-overlay').classList.add('hidden');
        await fetchResults();
        // ดึงข้อมูลใหม่โดยอัตโนมัติทุกๆ 5 วินาที (Real-time polling)
        pollInterval = setInterval(fetchResults, 5000);
    } else {
        document.getElementById('admin-login-overlay').classList.remove('hidden');
    }

    // เปิดให้กดปุ่ม Enter สำหรับเข้าล็อกอินได้เลย
    const pwdInput = document.getElementById('admin-password-input');
    if (pwdInput) {
        pwdInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                loginAdmin();
            }
        });
    }
};

// ----------------------------------------------------
// ดึงข้อมูลผลการเลือกตั้งจาก Backend API
// ----------------------------------------------------
async function fetchResults() {
    try {
        const password = sessionStorage.getItem('adminPassword');
        if (!password) return;

        const response = await fetch('/api/results', {
            headers: {
                'x-admin-password': password
            }
        });

        if (response.status === 401) {
            sessionStorage.removeItem('adminPassword');
            if (pollInterval) clearInterval(pollInterval);
            document.getElementById('admin-login-overlay').classList.remove('hidden');
            return;
        }

        if (!response.ok) {
            throw new Error('ไม่สามารถดึงข้อมูลผลการเลือกตั้งได้');
        }

        const data = await response.json();

        // 1. อัปเดตการ์ดตัวเลขสถิติ (Metrics)
        document.getElementById('stat-total-eligible').innerText = `${data.summary.total_eligible} คน`;
        document.getElementById('stat-total-voted').innerText = `${data.summary.total_voted} คน`;
        document.getElementById('stat-total-not-voted').innerText = `${data.summary.total_not_voted} คน`;
        document.getElementById('stat-turnout-rate').innerText = `${data.summary.voted_percentage} %`;

        // อัปเดตช่องป้อนข้อมูลการตั้งค่า (โหลดครั้งแรกหรือหลังบันทึกเท่านั้น เพื่อไม่ให้กวนเวลาแอดมินกำลังกรอก)
        if (!isSettingsLoaded) {
            const totalStudentsInput = document.getElementById('input-total-students');
            if (totalStudentsInput) {
                totalStudentsInput.value = data.summary.total_eligible;
            }
            const startInput = document.getElementById('voting-start-input');
            if (startInput) {
                startInput.value = toDatetimeLocal(data.voting_start_time);
            }
            const endInput = document.getElementById('voting-end-input');
            if (endInput) {
                endInput.value = toDatetimeLocal(data.voting_end_time);
            }
            isSettingsLoaded = true;
        }

        // 2. อัปเดตกราฟแท่งคะแนนโหวต (Candidates Votes Bar Chart)
        updateVotesChart(data);

        // 3. อัปเดตกราฟวงกลมผู้ใช้สิทธิ์ (Turnout Pie Chart)
        updateTurnoutChart(data);

        // 4. อัปเดตตารางสรุปผลคะแนนแบบตัวอักษร
        updateResultsTable(data);

    } catch (err) {
        console.error('Error fetching results:', err);
    }
}

// ----------------------------------------------------
// อัปเดตกราฟแท่งผลคะแนนโหวต
// ----------------------------------------------------
function updateVotesChart(data) {
    // จัดกลุ่มข้อมูลป้ายชื่อ (Labels) และจำนวนโหวต (Votes)
    const labels = data.candidates.map(c => `เบอร์ ${c.candidate_number}: ${c.name}`);
    const votes = data.candidates.map(c => c.votes);

    // เพิ่มตัวเลือก "ไม่ประสงค์ลงคะแนน" ลงไปในกราฟ
    labels.push('ไม่ประสงค์ลงคะแนน (No Vote)');
    votes.push(data.no_vote_count);

    const ctx = document.getElementById('chart-votes').getContext('2d');

    const chartColors = [
        'rgba(79, 70, 229, 0.75)',  // Indigo
        'rgba(16, 185, 129, 0.75)', // Emerald
        'rgba(245, 158, 11, 0.75)', // Amber
        'rgba(100, 116, 139, 0.6)'  // Slate (No Vote)
    ];

    const chartBorderColors = [
        'rgba(79, 70, 229, 1)',
        'rgba(16, 185, 129, 1)',
        'rgba(245, 158, 11, 1)',
        'rgba(100, 116, 139, 1)'
    ];

    if (votesChart === null) {
        // สร้างกราฟใหม่ครั้งแรก
        votesChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'จำนวนเสียงที่ได้รับ (คะแนน)',
                    data: votes,
                    backgroundColor: chartColors.slice(0, votes.length),
                    borderColor: chartBorderColors.slice(0, votes.length),
                    borderWidth: 2,
                    borderRadius: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            stepSize: 1,
                            font: { family: 'Kanit' }
                        },
                        grid: {
                            color: 'rgba(148, 163, 184, 0.1)'
                        }
                    },
                    x: {
                        ticks: {
                            font: { family: 'Kanit', size: 11 }
                        },
                        grid: {
                            display: false
                        }
                    }
                }
            }
        });
    } else {
        // อัปเดตข้อมูลกราฟเดิม (เพื่อป้องกันการกระพริบของ UI)
        votesChart.data.labels = labels;
        votesChart.data.datasets[0].data = votes;
        votesChart.data.datasets[0].backgroundColor = chartColors.slice(0, votes.length);
        votesChart.data.datasets[0].borderColor = chartBorderColors.slice(0, votes.length);
        votesChart.update();
    }
}

// ----------------------------------------------------
// อัปเดตกราฟวงกลมสรุปผู้มีสิทธิ์โหวต
// ----------------------------------------------------
function updateTurnoutChart(data) {
    const ctx = document.getElementById('chart-turnout').getContext('2d');
    const votedVal = data.summary.total_voted;
    const notVotedVal = data.summary.total_not_voted;

    if (turnoutChart === null) {
        turnoutChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['มาใช้สิทธิ์โหวตแล้ว', 'ยังไม่มาใช้สิทธิ์'],
                datasets: [{
                    data: [votedVal, notVotedVal],
                    backgroundColor: [
                        'rgba(79, 70, 229, 0.8)', // Indigo
                        'rgba(226, 232, 240, 0.8)' // Slate light
                    ],
                    borderWidth: 2,
                    borderColor: '#ffffff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: {
                        display: false
                    }
                }
            }
        });
    } else {
        turnoutChart.data.datasets[0].data = [votedVal, notVotedVal];
        turnoutChart.update();
    }
}

// ----------------------------------------------------
// อัปเดตตารางผลสรุปข้อมูล
// ----------------------------------------------------
function updateResultsTable(data) {
    const tbody = document.getElementById('results-table-body');
    tbody.innerHTML = '';

    const totalVotesCast = data.summary.total_voted;

    // 1. เพิ่มผู้สมัครทีละคนในตาราง
    data.candidates.forEach(c => {
        const percentage = totalVotesCast > 0 ? ((c.votes / totalVotesCast) * 100).toFixed(1) : 0;
        
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-50 transition duration-150';
        tr.innerHTML = `
            <td class="py-3 px-4 font-bold text-indigo-600">เบอร์ ${c.candidate_number}</td>
            <td class="py-3 px-4 font-medium text-slate-700">${c.name}</td>
            <td class="py-3 px-4 text-right font-bold text-slate-800">${c.votes}</td>
            <td class="py-3 px-4 text-right text-slate-500 font-semibold">${percentage}%</td>
        `;
        tbody.appendChild(tr);
    });

    // 2. เพิ่มแถว "ไม่ประสงค์ลงคะแนน" (No Vote)
    const noVotePercentage = totalVotesCast > 0 ? ((data.no_vote_count / totalVotesCast) * 100).toFixed(1) : 0;
    const trNoVote = document.createElement('tr');
    trNoVote.className = 'hover:bg-slate-50 transition duration-150 bg-slate-50/50';
    trNoVote.innerHTML = `
        <td class="py-3 px-4 font-bold text-slate-500">-</td>
        <td class="py-3 px-4 text-slate-500 font-medium italic">ไม่ประสงค์ลงคะแนน</td>
        <td class="py-3 px-4 text-right font-bold text-slate-500">${data.no_vote_count}</td>
        <td class="py-3 px-4 text-right text-slate-400 font-semibold">${noVotePercentage}%</td>
    `;
    tbody.appendChild(trNoVote);
}

// ----------------------------------------------------
// เรียกใช้งาน Seeding จำลองระบบ
// ----------------------------------------------------
async function triggerSeedData() {
    if (!confirm('คำเตือน: การจำลองข้อมูลตัวอย่างจะทำการล้างข้อมูลการเลือกตั้งทั้งหมด (TRUNCATE) และตั้งค่าผู้สมัครใหม่พร้อมรหัสนักเรียน 5 คน ต้องการดำเนินการต่อหรือไม่?')) {
        return;
    }

    try {
        const password = sessionStorage.getItem('adminPassword');
        const response = await fetch('/api/seed', { 
            method: 'POST',
            headers: {
                'x-admin-password': password
            }
        });
        const result = await response.json();

        if (response.ok && result.success) {
            alert('✅ สำเร็จ: ' + result.message);
            // โหลดผลใหม่ทันทีเพื่อให้กราฟอัปเดต
            await fetchResults();
        } else {
            alert('❌ ผิดพลาด: ' + (result.error || 'ไม่สามารถสั่งจำลองข้อมูลได้'));
        }
    } catch (err) {
        console.error('Seeding request error:', err);
        alert('❌ ผิดพลาด: ไม่สามารถติดต่อเซิร์ฟเวอร์ได้');
    }
}

// ----------------------------------------------------
// บันทึกการตั้งค่าจำนวนผู้มีสิทธิ์เลือกตั้งทั้งหมดไปยัง API
// ----------------------------------------------------
async function saveTotalStudents() {
    const input = document.getElementById('input-total-students');
    if (!input) return;

    const value = parseInt(input.value, 10);
    if (isNaN(value) || value <= 0) {
        alert('กรุณาระบุจำนวนผู้มีสิทธิ์เลือกตั้งที่มากกว่า 0');
        return;
    }

    try {
        const password = sessionStorage.getItem('adminPassword');
        const response = await fetch('/api/settings/total-students', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-admin-password': password
            },
            body: JSON.stringify({ value: value })
        });

        const data = await response.json();
        if (response.ok && data.success) {
            alert('✅ บันทึกสถิติจำนวนนักเรียนทั้งหมดเรียบร้อยแล้ว');
            isSettingsLoaded = false;
            await fetchResults(); // ดึงผลและคำนวณสถิติใหม่ทันที
        } else {
            alert('❌ ไม่สามารถบันทึกได้: ' + (data.error || 'กรุณาลองอีกครั้ง'));
        }
    } catch (err) {
        console.error('Save settings error:', err);
        alert('❌ ไม่สามารถติดต่อเซิร์ฟเวอร์เพื่อบันทึกการตั้งค่าได้');
    }
}

// ----------------------------------------------------
// จัดการล็อกอินและล็อกเอาท์ผู้ดูแลระบบ
// ----------------------------------------------------
async function loginAdmin() {
    const input = document.getElementById('admin-password-input');
    const errorText = document.getElementById('login-error-text');
    if (!input || !errorText) return;

    const password = input.value;
    if (password.length !== 6 || isNaN(password)) {
        errorText.innerText = 'กรุณากรอกรหัสผ่านเป็นตัวเลข 6 หลัก';
        errorText.classList.remove('hidden');
        return;
    }

    try {
        const response = await fetch('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });

        const data = await response.json();
        if (response.ok && data.success) {
            sessionStorage.setItem('adminPassword', password);
            document.getElementById('admin-login-overlay').classList.add('hidden');
            errorText.classList.add('hidden');
            input.value = '';
            
            // เริ่มต้นการดึงข้อมูลสถิติใหม่
            isSettingsLoaded = false;
            await fetchResults();
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = setInterval(fetchResults, 5000);
        } else {
            errorText.innerText = data.error || 'รหัสผ่านไม่ถูกต้อง';
            errorText.classList.remove('hidden');
        }
    } catch (err) {
        console.error('Login request error:', err);
        errorText.innerText = 'ไม่สามารถติดต่อเซิร์ฟเวอร์ได้';
        errorText.classList.remove('hidden');
    }
}

function logoutAdmin() {
    sessionStorage.removeItem('adminPassword');
    isSettingsLoaded = false;
    window.location.reload();
}

// ----------------------------------------------------
// บันทึกและรีเซ็ตช่วงเวลาเปิด-ปิดโหวต
// ----------------------------------------------------
async function saveVotingTime() {
    const startInput = document.getElementById('voting-start-input');
    const endInput = document.getElementById('voting-end-input');
    if (!startInput || !endInput) return;

    const startTime = startInput.value;
    const endTime = endInput.value;

    // ตรวจสอบความถูกต้องของตรรกะเวลาเบื้องต้น (ถ้ากรอกทั้งคู่ ต้องให้เวลาเริ่ม < เวลาปิด)
    if (startTime && endTime && new Date(startTime) >= new Date(endTime)) {
        alert('❌ ผิดพลาด: วันเวลาเริ่มต้นโหวตจะต้องมาถึงก่อนวันเวลาสิ้นสุดโหวต');
        return;
    }

    // แปลงวันเวลาที่กรอกใน timezone ท้องถิ่นของเบราว์เซอร์ให้เป็น ISO string (UTC) เพื่อจัดเก็บแบบเป็นกลางบนฐานข้อมูล
    const startTimeIso = startTime ? new Date(startTime).toISOString() : '';
    const endTimeIso = endTime ? new Date(endTime).toISOString() : '';

    try {
        const password = sessionStorage.getItem('adminPassword');
        const response = await fetch('/api/settings/voting-time', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-admin-password': password
            },
            body: JSON.stringify({
                start_time: startTimeIso,
                end_time: endTimeIso
            })
        });

        const data = await response.json();
        if (response.ok && data.success) {
            alert('✅ บันทึกช่วงเวลาเปิด-ปิดโหวตสำเร็จ');
            isSettingsLoaded = false;
            await fetchResults(); // อัปเดตสถิติตามกรอบเวลาใหม่
        } else {
            alert('❌ ไม่สามารถบันทึกได้: ' + (data.error || 'กรุณาลองอีกครั้ง'));
        }
    } catch (err) {
        console.error('Save voting time error:', err);
        alert('❌ ไม่สามารถติดต่อเซิร์ฟเวอร์เพื่อบันทึกการตั้งค่าได้');
    }
}

async function clearVotingTime() {
    if (!confirm('ต้องการล้างช่วงเวลาเปิด-ปิดโหวตเพื่อปล่อยให้โหวตได้ตลอดเวลาใช่หรือไม่?')) {
        return;
    }

    const startInput = document.getElementById('voting-start-input');
    const endInput = document.getElementById('voting-end-input');
    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';

    try {
        const password = sessionStorage.getItem('adminPassword');
        const response = await fetch('/api/settings/voting-time', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-admin-password': password
            },
            body: JSON.stringify({
                start_time: '',
                end_time: ''
            })
        });

        const data = await response.json();
        if (response.ok && data.success) {
            alert('✅ ล้างช่วงเวลาลงคะแนนสำเร็จ (ระบบจะเปิดให้โหวตได้ตลอดเวลา)');
            isSettingsLoaded = false;
            await fetchResults();
        } else {
            alert('❌ ไม่สามารถล้างค่าได้: ' + (data.error || 'กรุณาลองอีกครั้ง'));
        }
    } catch (err) {
        console.error('Clear voting time error:', err);
        alert('❌ ไม่สามารถติดต่อเซิร์ฟเวอร์เพื่อล้างค่าการตั้งค่าได้');
    }
}

// ฟังก์ชันแปลง ISO UTC String เป็น datetime-local สำหรับแสดงผลในเขตเวลาของบราว์เซอร์ผู้ใช้
function toDatetimeLocal(isoString) {
    if (!isoString) return '';
    try {
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return '';
        // ปรับเวลาโดยชดเชยค่าเบี่ยงเบนเขตเวลาของคอมพิวเตอร์ปัจจุบัน (Timezone Offset)
        const tzOffset = date.getTimezoneOffset() * 60000;
        const localTime = new Date(date.getTime() - tzOffset);
        return localTime.toISOString().slice(0, 16);
    } catch (e) {
        console.error('Error formatting datetime-local:', e);
        return '';
    }
}
