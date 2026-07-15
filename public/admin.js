// ตัวแปรสำหรับเก็บอินสแตนซ์ของ Chart.js
let votesChart = null;
let turnoutChart = null;

// image cache สำหรับวาดรูปในกราฟ
const imageCache = {};

function getLoadedImage(url, callback) {
    if (!url) return null;
    if (imageCache[url]) {
        if (imageCache[url].loaded) {
            return imageCache[url].img;
        }
        if (callback && !imageCache[url].callbacks.includes(callback)) {
            imageCache[url].callbacks.push(callback);
        }
        return null;
    }
    const img = new Image();
    imageCache[url] = {
        img: img,
        loaded: false,
        callbacks: callback ? [callback] : []
    };
    img.onload = () => {
        imageCache[url].loaded = true;
        imageCache[url].callbacks.forEach(cb => cb());
        imageCache[url].callbacks = [];
    };
    img.onerror = () => {
        imageCache[url].loaded = true;
        imageCache[url].callbacks = [];
    };
    img.src = url;
    return null;
}

const barLogoPlugin = {
    id: 'barLogoPlugin',
    beforeDraw(chart) {
        const x = chart.scales.x;
        if (!x || typeof x.getLabelItems !== 'function') return;
        
        // ตรวจสอบว่าเคยทำการ override ฟังก์ชัน getLabelItems ของแกน x ไปแล้วหรือยัง
        if (!x._originalGetLabelItems) {
            x._originalGetLabelItems = x.getLabelItems;
            x.getLabelItems = function() {
                // เรียกใช้ฟังก์ชันเดิมเพื่อเอาลิสต์ป้ายชื่อออกมา
                const items = x._originalGetLabelItems.call(this);
                const meta = chart.getDatasetMeta(0);
                items.forEach((item, i) => {
                    const bar = meta.data[i];
                    if (bar) {
                        // บังคับเปลี่ยนตำแหน่ง x ให้ตรงกับจุดกึ่งกลางของแท่งคะแนน (Bar/Logo Center) และจัดกึ่งกลาง
                        item.x = bar.x;
                        item.textAlign = 'center';
                    }
                });
                return items;
            };
        }
    },
    afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const logos = chart.options.plugins.customLogos;
        if (!logos) return;

        const meta = chart.getDatasetMeta(0);
        meta.data.forEach((bar, index) => {
            const logoUrl = logos[index];
            if (!logoUrl) return;

            const img = getLoadedImage(logoUrl);

            if (img) {
                const size = 32; // Size of the logo circle
                const xPos = bar.x - size / 2;
                const yPos = bar.y - size - 8;

                // Draw white background circle with shadow
                ctx.save();
                ctx.beginPath();
                ctx.arc(bar.x, bar.y - size / 2 - 8, size / 2 + 2, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
                ctx.shadowBlur = 4;
                ctx.shadowOffsetY = 2;
                ctx.fill();
                ctx.restore();

                // Draw the logo itself (clipped to a circle)
                ctx.save();
                ctx.beginPath();
                ctx.arc(bar.x, bar.y - size / 2 - 8, size / 2, 0, Math.PI * 2);
                ctx.clip();
                ctx.drawImage(img, xPos, yPos, size, size);
                ctx.restore();
            }
        });
    }
};

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

    // สั่งให้กราฟอัปเดตใหม่เมื่อฟอนต์ทั้งหมดโหลดเสร็จแล้ว ป้องกันปัญหารูปร่างฟอนต์เพี้ยนบน iPad/Safari
    if (document.fonts) {
        document.fonts.ready.then(() => {
            if (votesChart) votesChart.update();
            if (turnoutChart) turnoutChart.update();
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

        // 5. อัปเดตรายชื่อผู้สมัครในช่องจำลองการโหวต
        const select = document.getElementById('sim-candidate-select');
        if (select && select.children.length === 0) {
            select.innerHTML = '';
            data.candidates.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.id;
                opt.textContent = `เบอร์ ${c.candidate_number}: ${c.name}`;
                select.appendChild(opt);
            });
            const optNo = document.createElement('option');
            optNo.value = '';
            optNo.textContent = 'ไม่ประสงค์ลงคะแนน (No Vote)';
            select.appendChild(optNo);
        }

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

    // ดึง URL โลโก้ของผู้สมัครแต่ละเบอร์
    const imagePaths = data.candidates.map(c => c.image_url || '');

    // เพิ่มตัวเลือก "ไม่ประสงค์ลงคะแนน" ลงไปในกราฟ
    labels.push('ไม่ประสงค์ลงคะแนน (No Vote)');
    votes.push(data.no_vote_count);
    imagePaths.push(''); // No Vote has no logo

    // สั่งโหลดรูปภาพไว้ก่อนล่วงหน้าเพื่อลดปัญหาการอัปเดตกราฟซ้ำซ้อนใน iOS/Safari
    imagePaths.forEach(url => {
        if (url) {
            getLoadedImage(url, () => {
                if (votesChart) {
                    votesChart.update('none');
                }
            });
        }
    });

    const ctx = document.getElementById('chart-votes').getContext('2d');

    const chartColors = [
        'rgba(37, 99, 235, 0.75)',  // Blue
        'rgba(16, 185, 129, 0.75)', // Emerald
        'rgba(245, 158, 11, 0.75)', // Amber
        'rgba(100, 116, 139, 0.6)'  // Slate (No Vote)
    ];

    const chartBorderColors = [
        'rgba(37, 99, 235, 1)',
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
                layout: {
                    padding: {
                        left: 15,
                        right: 15,
                        top: 5,
                        bottom: 5
                    }
                },
                plugins: {
                    legend: {
                        display: false
                    },
                    customLogos: imagePaths
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grace: '18%', // เผื่อพื้นที่ด้านบนสำหรับวาดโลโก้พรรค
                        ticks: {
                            stepSize: 1,
                            font: { family: 'Kanit, sans-serif' }
                        },
                        grid: {
                            color: 'rgba(148, 163, 184, 0.1)'
                        }
                    },
                    x: {
                        ticks: {
                            font: { family: 'Kanit, sans-serif', size: 11 }
                        },
                        grid: {
                            display: false
                        }
                    }
                }
            },
            plugins: [barLogoPlugin]
        });
    } else {
        // อัปเดตข้อมูลกราฟเดิม (เพื่อป้องกันการกระพริบของ UI)
        votesChart.data.labels = labels;
        votesChart.data.datasets[0].data = votes;
        votesChart.data.datasets[0].backgroundColor = chartColors.slice(0, votes.length);
        votesChart.data.datasets[0].borderColor = chartBorderColors.slice(0, votes.length);
        votesChart.options.plugins.customLogos = imagePaths;
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
                        'rgba(37, 99, 235, 0.8)', // Blue
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
            <td class="py-3 px-4 font-bold text-blue-600">เบอร์ ${c.candidate_number}</td>
            <td class="py-3 px-4 font-medium text-slate-700">
                <div class="flex items-center space-x-3">
                    ${c.image_url ? `<img src="${c.image_url}" class="w-8 h-8 rounded-full object-cover border border-slate-100 shadow-sm">` : '<div class="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 text-xs font-bold">?</div>'}
                    <span>${c.name}</span>
                </div>
            </td>
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

// ----------------------------------------------------
// เพิ่มคะแนนเสียงจำลอง
// ----------------------------------------------------
async function addSimulatedVotes() {
    const password = sessionStorage.getItem('adminPassword');
    if (!password) return;

    const select = document.getElementById('sim-candidate-select');
    const input = document.getElementById('sim-vote-count');
    if (!select || !input) return;

    const candidateId = select.value === '' ? null : parseInt(select.value, 10);
    const count = parseInt(input.value, 10);

    if (isNaN(count) || count <= 0) {
        alert('กรุณากรอกจำนวนโหวตที่ถูกต้อง (ต้องมากกว่า 0)');
        return;
    }

    try {
        const button = document.querySelector('button[onclick="addSimulatedVotes()"]');
        if (button) {
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-spinner animate-spin"></i> <span>กำลังเพิ่มคะแนน...</span>';
        }

        const response = await fetch('/api/admin/add-votes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-password': password
            },
            body: JSON.stringify({
                candidate_id: candidateId,
                count: count
            })
        });

        const result = await response.json();

        if (response.ok) {
            // อัปเดตข้อมูลผลลัพธ์ทันทีหลังจากส่งคะแนน
            await fetchResults();
            alert(`✅ ${result.message}`);
        } else {
            alert(`❌ ผิดพลาด: ${result.error || 'ไม่สามารถเพิ่มคะแนนเสียงได้'}`);
        }
    } catch (err) {
        console.error('Error adding simulated votes:', err);
        alert('❌ เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
    } finally {
        const button = document.querySelector('button[onclick="addSimulatedVotes()"]');
        if (button) {
            button.disabled = false;
            button.innerHTML = '<i class="fa-solid fa-plus"></i> <span>เพิ่มคะแนนโหวตจำลอง</span>';
        }
    }
}
