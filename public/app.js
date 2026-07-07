// เก็บข้อมูลสถานะของระบบ
let state = {
    lineUserId: null,
    lineDisplayName: 'Voter Name',
    linePictureUrl: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&w=100&q=80',
    candidates: [],
    selectedCandidate: null
};

// ----------------------------------------------------
// ฟังก์ชันเริ่มต้นระบบ (App Initialization)
// ----------------------------------------------------
window.onload = async function() {
    try {
        // ดึง LIFF ID จาก Backend เพื่อลดการ Hardcode ในโค้ด
        const configRes = await fetch('/api/config');
        const config = await configRes.json();

        // เริ่มต้นใช้งาน LIFF SDK
        await liff.init({ liffId: config.liffId });

        if (liff.isLoggedIn()) {
            const profile = await liff.getProfile();
            state.lineUserId = profile.userId;
            state.lineDisplayName = profile.displayName;
            state.linePictureUrl = profile.pictureUrl || state.linePictureUrl;
            
            // อัปเดตข้อมูลบนหน้าจอลงทะเบียน
            document.getElementById('line-display-name').innerText = state.lineDisplayName;
            document.getElementById('line-avatar').src = state.linePictureUrl;

            // ตรวจสอบสถานะการลงทะเบียนและการโหวตในฐานข้อมูล
            await checkVoterStatus();
        } else {
            // หากไม่ได้เข้าสู่ระบบ ให้ทำการ Login
            liff.login();
        }
    } catch (err) {
        console.warn('⚠️ LIFF Initialization failed. อาจเปิดอยู่นอกแอป LINE. กำลังแสดงโหมดจำลอง...', err);
        // แสดงฟอร์ม Mock สำหรับให้นักพัฒนาหรือผู้ประเมินระบบทดสอบบน Browser ทั่วไปได้ง่ายขึ้น
        document.getElementById('screen-loading').classList.add('hidden');
        document.getElementById('screen-mock').classList.remove('hidden');
    }
};

// ฟังก์ชันจำลองโปรไฟล์ LINE ในกรณีรันบน Browser ปกติ
async function useMockProfile() {
    const mockId = document.getElementById('mock-line-id').value.trim();
    const mockName = document.getElementById('mock-line-name').value.trim();

    if (!mockId || !mockName) {
        alert('กรุณากรอกข้อมูลจำลองให้ครบถ้วน');
        return;
    }

    state.lineUserId = mockId;
    state.lineDisplayName = mockName;
    
    // อัปเดต UI
    document.getElementById('line-display-name').innerText = state.lineDisplayName;
    document.getElementById('line-avatar').src = state.linePictureUrl;

    document.getElementById('screen-mock').classList.add('hidden');
    document.getElementById('screen-loading').classList.remove('hidden');
    
    await checkVoterStatus();
}

// ----------------------------------------------------
// การเปลี่ยนหน้าจอ (Screen Controllers)
// ----------------------------------------------------
function showScreen(screenId) {
    // ซ่อนทุกหน้าจอ
    document.getElementById('screen-loading').classList.add('hidden');
    document.getElementById('screen-register').classList.add('hidden');
    document.getElementById('screen-voting').classList.add('hidden');
    document.getElementById('screen-success').classList.add('hidden');

    // แสดงหน้าจอเป้าหมาย
    document.getElementById(screenId).classList.remove('hidden');
}

// ----------------------------------------------------
// ดึงข้อมูลและตรวจสอบสถานะผู้ใช้ (API Communications)
// ----------------------------------------------------
async function checkVoterStatus() {
    try {
        const response = await fetch(`/api/voter-status?line_id=${state.lineUserId}`);
        const data = await response.json();

        if (data.registered) {
            if (data.has_voted) {
                // หากผูกสิทธิ์และโหวตไปแล้ว -> แสดงหน้าโหวตสำเร็จ
                showScreen('screen-success');
            } else {
                // หากผูกสิทธิ์แล้วแต่ยังไม่ได้โหวต -> โหลดรายชื่อผู้สมัครและพาไปโหวต
                document.getElementById('voter-name-title').innerText = `${data.student.name} ${data.student.surname} (${data.student.student_id})`;
                await loadCandidates();
                showScreen('screen-voting');
            }
        } else {
            // หากยังไม่ได้ผูกสิทธิ์ -> พาไปหน้าลงทะเบียน
            showScreen('screen-register');
        }
    } catch (err) {
        console.error('Error checking status:', err);
        alert('เกิดข้อผิดพลาดในการดึงข้อมูลสถานะผู้ใช้งาน');
        showScreen('screen-register');
    }
}

// ผูกสิทธิ์ LINE เข้ากับรหัสนักเรียน
async function registerStudent() {
    const studentIdInput = document.getElementById('input-student-id');
    const studentId = studentIdInput.value.trim();
    const errorBox = document.getElementById('register-error');
    const errorText = document.getElementById('register-error-text');

    if (!studentId) {
        errorText.innerText = 'กรุณากรอกรหัสนักเรียน';
        errorBox.classList.remove('hidden');
        return;
    }

    errorBox.classList.add('hidden');

    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                line_id: state.lineUserId,
                student_id: studentId
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            // สำเร็จ -> ตรวจสอบสถานะการโหวตใหม่เพื่อดึงข้อมูลผู้สมัคร
            await checkVoterStatus();
        } else {
            // เกิดข้อผิดพลาดจาก Backend
            errorText.innerText = data.error || 'เกิดข้อผิดพลาดในการตรวจสอบสิทธิ์';
            errorBox.classList.remove('hidden');
        }
    } catch (err) {
        console.error('Registration error:', err);
        errorText.innerText = 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้';
        errorBox.classList.remove('hidden');
    }
}

// โหลดรายชื่อผู้สมัคร
async function loadCandidates() {
    try {
        const response = await fetch('/api/candidates');
        const data = await response.json();
        state.candidates = data;
        
        renderCandidates();
    } catch (err) {
        console.error('Load candidates error:', err);
        alert('เกิดข้อผิดพลาดในการโหลดข้อมูลผู้สมัคร');
    }
}

// ----------------------------------------------------
// ฟังก์ชันเรนเดอร์ UI (UI Renderers)
// ----------------------------------------------------
function renderCandidates() {
    const container = document.getElementById('candidates-container');
    container.innerHTML = '';

    if (state.candidates.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8 text-slate-500">
                <i class="fa-solid fa-folder-open text-3xl mb-2"></i>
                <p class="text-sm">ไม่มีข้อมูลผู้สมัครในระบบ</p>
            </div>
        `;
        return;
    }

    state.candidates.forEach(candidate => {
        const card = document.createElement('div');
        card.className = 'glass-card rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition duration-200 border border-slate-200/50 flex flex-col';
        
        card.innerHTML = `
            <div class="flex h-36">
                <!-- Candidate Image -->
                <div class="w-1/3 relative bg-slate-100 flex-shrink-0">
                    <img src="${candidate.image_url || 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=300&q=80'}" 
                         alt="${candidate.name}" 
                         class="w-full h-full object-cover">
                    <!-- Candidate Number Badge -->
                    <div class="absolute top-2 left-2 bg-indigo-600 text-white font-bold text-sm w-8 h-8 rounded-lg flex items-center justify-center shadow-md">
                        ${candidate.candidate_number}
                    </div>
                </div>
                <!-- Candidate Info -->
                <div class="w-2/3 p-4 flex flex-col justify-between">
                    <div>
                        <h3 class="font-bold text-slate-800 leading-tight">เบอร์ ${candidate.candidate_number}: ${candidate.name} ${candidate.surname}</h3>
                        <p class="text-xs text-slate-500 line-clamp-3 mt-1.5">${candidate.policy}</p>
                    </div>
                    <button onclick="confirmVote(${candidate.id})" class="mt-2 py-1.5 bg-indigo-50 hover:bg-indigo-600 text-indigo-600 hover:text-white font-semibold text-xs rounded-lg transition duration-150 w-full">
                        ลงคะแนนเลือก
                    </button>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

// ----------------------------------------------------
// ระบบยืนยันการโหวตและส่งคะแนน (Voting Confirm & Submission)
// ----------------------------------------------------
function confirmVote(candidateId) {
    const modal = document.getElementById('confirm-modal');
    const avatar = document.getElementById('confirm-avatar');
    const avatarBox = document.getElementById('confirm-avatar-box');
    const noVoteIcon = document.getElementById('confirm-no-vote-icon');
    const badge = document.getElementById('confirm-badge');
    const title = document.getElementById('confirm-title'); // (Wait: In HTML we have h3 which doesn't have id confirm-title. Let's fix this in variables)
    const policy = document.getElementById('confirm-policy');
    const submitBtn = document.getElementById('btn-submit-vote');

    if (candidateId === null) {
        // กรณี "ไม่ประสงค์ลงคะแนน"
        state.selectedCandidate = null;
        avatar.classList.add('hidden');
        noVoteIcon.classList.remove('hidden');
        badge.innerText = 'NO VOTE';
        badge.className = 'inline-block bg-slate-500 text-white text-xs font-bold px-3 py-1 rounded-full mb-2';
        policy.innerText = 'ส่งผลบัตรเปล่า ไม่เลือกผู้สมัครท่านใด';
        
        submitBtn.onclick = () => submitVote(null);
    } else {
        // กรณีเลือกผู้สมัคร
        const candidate = state.candidates.find(c => c.id === candidateId);
        if (!candidate) return;

        state.selectedCandidate = candidate;
        avatar.src = candidate.image_url || 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=300&q=80';
        avatar.classList.remove('hidden');
        noVoteIcon.classList.add('hidden');
        badge.innerText = `เบอร์ ${candidate.candidate_number}`;
        badge.className = 'inline-block bg-indigo-600 text-white text-xs font-bold px-3 py-1 rounded-full mb-2';
        policy.innerText = `นโยบาย: "${candidate.policy}"`;

        submitBtn.onclick = () => submitVote(candidate.id);
    }

    // แสดง Modal
    modal.classList.remove('hidden');
}

function closeModal() {
    const modal = document.getElementById('confirm-modal');
    modal.classList.add('hidden');
}

async function submitVote(candidateId) {
    closeModal();
    showScreen('screen-loading');

    try {
        const response = await fetch('/api/vote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                line_id: state.lineUserId,
                candidate_id: candidateId
            })
        });

        const data = await response.json();

        if (response.ok && data.success) {
            showScreen('screen-success');
        } else {
            alert(data.error || 'เกิดข้อผิดพลาดในการบันทึกคะแนน');
            // นำผู้ใช้กลับไปตรวจสอบสถานะใหม่เพื่อโหลดหน้าจอที่ถูกต้อง
            await checkVoterStatus();
        }
    } catch (err) {
        console.error('Vote submission error:', err);
        alert('เกิดข้อผิดพลาดในการสื่อสารกับเซิร์ฟเวอร์');
        await checkVoterStatus();
    }
}
