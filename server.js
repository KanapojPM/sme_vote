const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1335555';

// มิดเดิลแวร์ตรวจสอบความถูกต้องรหัสผ่านแอดมิน
const verifyAdminPassword = (req, res, next) => {
  const xAdminPassword = req.headers['x-admin-password'];
  if (xAdminPassword !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'รหัสผ่านผู้ดูแลระบบไม่ถูกต้อง ไม่มีสิทธิ์เข้าถึงข้อมูล' });
  }
  next();
};

// ฟังก์ชันดึงสถานะเวลาลงคะแนนเสียง
async function getVotingTimeStatus() {
  try {
    const res = await pool.query("SELECT key, value FROM system_settings WHERE key IN ('voting_start_time', 'voting_end_time')");
    const settings = {};
    res.rows.forEach(row => {
      settings[row.key] = row.value;
    });

    const now = new Date();
    const startStr = settings.voting_start_time || '';
    const endStr = settings.voting_end_time || '';
    const startTime = startStr ? new Date(startStr) : null;
    const endTime = endStr ? new Date(endStr) : null;

    let status = 'open';
    if (startTime && now < startTime) {
      status = 'not_started';
    } else if (endTime && now > endTime) {
      status = 'ended';
    }
    return { status, start: startStr, end: endStr };
  } catch (error) {
    console.error('getVotingTimeStatus error:', error);
    return { status: 'open', start: '', end: '' };
  }
}

// การตั้งค่า Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// การเชื่อมต่อฐานข้อมูล PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '30', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com') 
    ? { rejectUnauthorized: false } // ปลดล็อค SSL สำหรับบาง Cloud DB เช่น Render
    : false
});

// ฟังก์ชันรันไฟล์ Schema เพื่อสร้าง Table อัตโนมัติ (เพื่อความง่ายในการติดตั้ง)
async function initDatabase() {
  try {
    const schemaPath = path.join(__dirname, 'db', 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(sql);
      // เพิ่มคอลัมน์ vote_type ในตาราง votes หากยังไม่มี
      await pool.query("ALTER TABLE votes ADD COLUMN IF NOT EXISTS vote_type VARCHAR(10) DEFAULT 'online'");
      // เคลียร์นโยบายจำลองเดิมในตาราง candidates ให้เป็นค่าว่างโดยอัตโนมัติ
      await pool.query(
        `UPDATE candidates SET policy = '' WHERE policy IN (
          'พรรคเพื่อการพัฒนาโรงเรียนและสร้างความสร้างสรรค์ในหมู่นักเรียน', 
          'กลุ่มนักเรียนรุ่นใหม่ เพื่อวันพรุ่งนี้ที่ดีกว่าสำหรับชาว SME'
        )`
      );
      console.log('✅ ตรวจสอบและสร้างโครงสร้างตาราง (Database Schema) สำเร็จ');
    }
  } catch (error) {
    console.error('❌ ไม่สามารถเริ่มต้นฐานข้อมูลได้:', error.message);
  }
}

// ----------------------------------------------------
// API Endpoints
// ----------------------------------------------------

// 1. ดึงข้อมูล Config (เช่น LIFF ID) ส่งไปให้ Frontend
app.get('/api/config', (req, res) => {
  res.json({
    liffId: process.env.LIFF_ID || 'mock-liff-id-12345'
  });
});

// 2. ตรวจสอบสถานะว่า LINE User ID นี้ผูกรหัสสิทธิ์หรือยัง และโหวตไปหรือยัง
app.get('/api/voter-status', async (req, res) => {
  const { line_id, name } = req.query;

  if (!line_id) {
    return res.status(400).json({ error: 'กรุณาระบุ line_id' });
  }

  try {
    const timeStatus = await getVotingTimeStatus();
    const result = await pool.query(
      'SELECT student_id, name, surname, has_voted FROM students WHERE line_id = $1',
      [line_id]
    );

    if (result.rows.length > 0) {
      const voter = result.rows[0];
      return res.json({
        registered: true,
        has_voted: voter.has_voted,
        voting_status: timeStatus.status,
        voting_start_time: timeStatus.start,
        voting_end_time: timeStatus.end,
        student: {
          student_id: voter.student_id,
          name: voter.name,
          surname: voter.surname
        }
      });
    } else {
      // ลงทะเบียนสิทธิ์ให้อัตโนมัติด้วย LINE User ID ทันทีที่เข้าเว็บครั้งแรก
      const displayName = name || 'ผู้ใช้ LINE';
      const studentId = line_id.substring(0, 50);

      await pool.query(
        'INSERT INTO students (student_id, line_id, name, surname) VALUES ($1, $2, $3, $4)',
        [studentId, line_id, displayName, '']
      );

      return res.json({
        registered: true,
        has_voted: false,
        voting_status: timeStatus.status,
        voting_start_time: timeStatus.start,
        voting_end_time: timeStatus.end,
        student: {
          student_id: studentId,
          name: displayName,
          surname: ''
        }
      });
    }
  } catch (error) {
    console.error('voter-status error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการตรวจสอบสถานะผู้โหวต' });
  }
});

// 3. ผูกรหัสนักเรียนกับ LINE User ID (ยืนยันสิทธิ์)
app.post('/api/register', async (req, res) => {
  const { line_id, student_id } = req.body;

  if (!line_id || !student_id) {
    return res.status(400).json({ error: 'กรุณากรอกข้อมูล line_id และ student_id ให้ครบถ้วน' });
  }

  try {
    // ใช้ Transaction เพื่อความปลอดภัย
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. เช็คว่ามีรหัสนักเรียนนี้ในระบบหรือไม่
      const studentCheck = await client.query(
        'SELECT student_id, name, surname, line_id FROM students WHERE student_id = $1',
        [student_id]
      );

      if (studentCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'ไม่พบรหัสนักเรียนนี้ในระบบ หรือไม่ได้รับสิทธิ์เลือกตั้ง' });
      }

      const student = studentCheck.rows[0];

      // 2. เช็คว่ารหัสนักเรียนนี้มีคนอื่นเอา LINE มาผูกหรือยัง
      if (student.line_id && student.line_id !== line_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'รหัสนักเรียนนี้ถูกผูกเข้ากับบัญชี LINE อื่นเรียบร้อยแล้ว' });
      }

      // 3. เช็คว่าบัญชี LINE นี้ถูกใช้ผูกกับรหัสนักเรียนอื่นไปแล้วหรือไม่
      const lineCheck = await client.query(
        'SELECT student_id FROM students WHERE line_id = $1',
        [line_id]
      );

      if (lineCheck.rows.length > 0 && lineCheck.rows[0].student_id !== student_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'บัญชี LINE นี้ผูกสิทธิ์เข้ากับรหัสนักเรียนอื่นไปแล้ว' });
      }

      // 4. บันทึกการผูกสิทธิ์
      await client.query(
        'UPDATE students SET line_id = $1 WHERE student_id = $2',
        [line_id, student_id]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'ลงทะเบียนผูกสิทธิ์สำเร็จ',
        student: {
          student_id: student.student_id,
          name: student.name,
          surname: student.surname
        }
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('register error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบในการผูกสิทธิ์' });
  }
});

// 4. ดึงข้อมูลรายชื่อผู้สมัครรับเลือกตั้ง
app.get('/api/candidates', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, candidate_number, name, surname, policy, image_url FROM candidates ORDER BY candidate_number ASC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('candidates error:', error);
    res.status(500).json({ error: 'ไม่สามารถดึงรายชื่อผู้สมัครได้' });
  }
});

// 5. ลงคะแนนโหวต (จุดสำคัญ: ความปลอดภัย & ป้องกัน Double Vote ด้วย Transaction + Row Lock)
app.post('/api/vote', async (req, res) => {
  const { line_id, candidate_id } = req.body; // candidate_id เป็น null ได้ในกรณี "ไม่ประสงค์ลงคะแนน"

  const timeStatus = await getVotingTimeStatus();
  if (timeStatus.status !== 'open') {
    return res.status(400).json({ error: 'ไม่อยู่ในช่วงเวลาเปิดลงคะแนนเสียง' });
  }

  if (!line_id) {
    return res.status(400).json({ error: 'กรุณาระบุ line_id' });
  }

  let client;
  try {
    client = await pool.connect();
    
    // เริ่ม Transaction
    await client.query('BEGIN');

    // 1. ค้นหานักเรียนด้วย LINE ID และทำการ Lock Row ด้วย FOR UPDATE เพื่อป้องกัน Race Condition จากการโหวตพร้อมกัน
    const voterCheck = await client.query(
      'SELECT student_id, has_voted FROM students WHERE line_id = $1 FOR UPDATE',
      [line_id]
    );

    if (voterCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'คุณไม่มีสิทธิ์ในการลงคะแนน (กรุณาลงทะเบียนก่อน)' });
    }

    const voter = voterCheck.rows[0];

    // 2. ตรวจสอบว่าโหวตไปแล้วหรือยัง
    if (voter.has_voted) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'คุณได้ลงคะแนนโหวตเรียบร้อยแล้ว ไม่สามารถโหวตซ้ำได้' });
    }

    // 3. ตรวจสอบว่าผู้สมัคร (Candidate) มีจริงในระบบหรือไม่ (กรณีไม่ได้เลือก No Vote)
    if (candidate_id !== null) {
      const candidateCheck = await client.query(
        'SELECT id FROM candidates WHERE id = $1',
        [candidate_id]
      );
      if (candidateCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'ไม่พบหมายเลขผู้สมัครที่คุณเลือกโหวต' });
      }
    }

    // 4. บันทึกคะแนนโหวต (ไม่มีการผูก student_id เพื่อความปลอดภัยของสิทธิ์และความลับ)
    await client.query(
      'INSERT INTO votes (candidate_id) VALUES ($1)',
      [candidate_id]
    );

    // 5. เปลี่ยนสถานะนักเรียนเป็น "ลงคะแนนแล้ว" เพื่อไม่ให้กลับมาโหวตได้อีก
    await client.query(
      'UPDATE students SET has_voted = TRUE WHERE line_id = $1',
      [line_id]
    );

    // บันทึกการเปลี่ยนแปลงทั้งหมด
    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'บันทึกคะแนนโหวตเรียบร้อยแล้ว ขอขอบพระคุณที่ใช้สิทธิ์'
    });
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        console.error('Rollback error:', rbErr);
      }
    }
    console.error('vote error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดทางเทคนิคในการส่งคะแนนโหวต' });
  } finally {
    if (client) client.release();
  }
});

// 6. ดึงสถิติผลคะแนนรวม (Real-time) สำหรับ Admin Dashboard (ป้องกันด้วยรหัสผ่าน)
app.get('/api/results', verifyAdminPassword, async (req, res) => {
  try {
    // 1. ดึงคะแนนแยกแต่ละผู้สมัคร (แยกโหวต online, onsite และ รวม)
    const candidateVotesQuery = `
      SELECT 
        c.id, 
        c.candidate_number, 
        c.name, 
        c.surname, 
        c.image_url,
        COUNT(CASE WHEN v.vote_type = 'online' THEN 1 END) AS online_votes,
        COUNT(CASE WHEN v.vote_type = 'onsite' THEN 1 END) AS onsite_votes,
        COUNT(v.id) AS total_votes
      FROM candidates c
      LEFT JOIN votes v ON c.id = v.candidate_id
      GROUP BY c.id, c.candidate_number, c.name, c.surname, c.image_url
      ORDER BY c.candidate_number ASC
    `;
    const candidateVotes = await pool.query(candidateVotesQuery);

    // 2. ดึงจำนวนโหวต "ไม่ประสงค์ลงคะแนน" (No Vote) (แยก online, onsite และ รวม)
    const noVotesQuery = `
      SELECT 
        COUNT(CASE WHEN vote_type = 'online' THEN 1 END) AS online_no_votes,
        COUNT(CASE WHEN vote_type = 'onsite' THEN 1 END) AS onsite_no_votes,
        COUNT(*) AS total_no_votes
      FROM votes 
      WHERE candidate_id IS NULL
    `;
    const noVotes = await pool.query(noVotesQuery);

    // 3. ดึงจำนวนผู้มีสิทธิ์เลือกตั้งและเวลาโหวตจากตารางตั้งค่า
    const settingsRes = await pool.query("SELECT key, value FROM system_settings WHERE key IN ('total_students', 'voting_start_time', 'voting_end_time')");
    const settings = {};
    settingsRes.rows.forEach(row => {
      settings[row.key] = row.value;
    });
    const totalEligible = parseInt(settings.total_students, 10) || 100;
    const votingStartTime = settings.voting_start_time || "";
    const votingEndTime = settings.voting_end_time || "";

    // 4. ดึงจำนวนผู้ใช้สิทธิ์จริง
    const votedRes = await pool.query("SELECT COUNT(*) AS total_voted FROM students WHERE has_voted = TRUE");
    const totalVoted = votedRes.rows.length > 0 ? parseInt(votedRes.rows[0].total_voted, 10) : 0;

    const totalNotVoted = Math.max(0, totalEligible - totalVoted);
    const votedPercentage = totalEligible > 0 ? ((totalVoted / totalEligible) * 100).toFixed(2) : "0.00";

    res.json({
      candidates: candidateVotes.rows.map(row => ({
        id: row.id,
        candidate_number: row.candidate_number,
        name: `${row.name} ${row.surname}`,
        image_url: row.image_url,
        votes: parseInt(row.total_votes, 10), // เกื้อหนุนกราฟแท่งดั้งเดิม
        online_votes: parseInt(row.online_votes, 10),
        onsite_votes: parseInt(row.onsite_votes, 10),
        total_votes: parseInt(row.total_votes, 10)
      })),
      no_vote_count: parseInt(noVotes.rows[0].total_no_votes, 10), // เกื้อหนุนกราฟวงกลมดั้งเดิม
      no_votes: {
        online: parseInt(noVotes.rows[0].online_no_votes, 10),
        onsite: parseInt(noVotes.rows[0].onsite_no_votes, 10),
        total: parseInt(noVotes.rows[0].total_no_votes, 10)
      },
      voting_start_time: votingStartTime,
      voting_end_time: votingEndTime,
      summary: {
        total_eligible: totalEligible,
        total_voted: totalVoted,
        total_not_voted: totalNotVoted,
        voted_percentage: votedPercentage
      }
    });
  } catch (error) {
    console.error('results error:', error);
    res.status(500).json({ error: 'ไม่สามารถดึงผลสถิติคะแนนโหวตได้' });
  }
});

// 6.5. บันทึกจำนวนผู้มีสิทธิ์เลือกตั้งทั้งหมด (ตั้งค่าจาก Admin Dashboard) (ป้องกันด้วยรหัสผ่าน)
app.post('/api/settings/total-students', verifyAdminPassword, async (req, res) => {
  const { value } = req.body;
  if (value === undefined || parseInt(value, 10) <= 0) {
    return res.status(400).json({ error: 'จำนวนผู้มีสิทธิ์เลือกตั้งต้องมากกว่า 0' });
  }

  try {
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('total_students', $1) 
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [value.toString()]
    );
    res.json({ success: true, message: 'บันทึกจำนวนผู้มีสิทธิ์เลือกตั้งทั้งหมดสำเร็จ' });
  } catch (error) {
    console.error('set total-students error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกค่าตั้งค่าระบบ' });
  }
});

// 6.6. บันทึกช่วงเวลาเปิด-ปิดโหวต (ตั้งค่าจาก Admin Dashboard) (ป้องกันด้วยรหัสผ่าน)
app.post('/api/settings/voting-time', verifyAdminPassword, async (req, res) => {
  const { start_time, end_time } = req.body;

  try {
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('voting_start_time', $1) 
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [start_time ? start_time.toString() : ""]
    );
    await pool.query(
      `INSERT INTO system_settings (key, value) VALUES ('voting_end_time', $1) 
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [end_time ? end_time.toString() : ""]
    );
    res.json({ success: true, message: 'บันทึกช่วงเวลาลงคะแนนเสียงสำเร็จ' });
  } catch (error) {
    console.error('set voting-time error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกเวลาเปิด-ปิดโหวต' });
  }
});

// 6.8. API สำหรับตรวจสอบสิทธิ์เข้าใช้งานหน้าแอดมิน (Login)
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, message: 'เข้าสู่ระบบสำเร็จ' });
  } else {
    res.status(401).json({ error: 'รหัสผ่านเข้าหน้าแอดมินไม่ถูกต้อง' });
  }
});

// 7. API สำหรับ Seed ข้อมูลจำลอง (ผู้สมัคร 3 คน และสิทธิ์นักเรียน 5 คน) (ป้องกันด้วยรหัสผ่าน)
app.post('/api/seed', verifyAdminPassword, async (req, res) => {
  try {
    // ตรวจสอบและรัน DDL Schema ก่อน
    await initDatabase();

    // ล้างข้อมูลเก่า
    await pool.query('TRUNCATE votes, students, candidates RESTART IDENTITY CASCADE');

    // ใส่ข้อมูลผู้สมัคร (Candidates)
    const seedCandidates = [
      [1, 'พรรคภูมิใจเทอ', '', '', 'https://smevote.vercel.app/group1.jpg'],
      [2, 'พรรค MORROW', '', '', 'https://smevote.vercel.app/group2.jpg']
    ];

    for (const c of seedCandidates) {
      await pool.query(
        'INSERT INTO candidates (candidate_number, name, surname, policy, image_url) VALUES ($1, $2, $3, $4, $5)',
        c
      );
    }

    // ใส่ข้อมูลนักเรียนจำลองที่มีสิทธิ์ (Students)
    const seedStudents = [
      ['65001', 'กิตติ', 'รักเรียน'],
      ['65002', 'ศิริ', 'งามตา'],
      ['65003', 'วิชัย', 'ประเสริฐยิ่ง'],
      ['65004', 'มณี', 'ศรีสวัสดิ์'],
      ['65005', 'สมพร', 'ดีงาม']
    ];

    for (const s of seedStudents) {
      await pool.query(
        'INSERT INTO students (student_id, name, surname) VALUES ($1, $2, $3)',
        s
      );
    }

    res.json({
      success: true,
      message: 'สร้างตารางและใส่ข้อมูลจำลองเรียบร้อยแล้ว (ผู้สมัคร 2 คน, สิทธิ์นักเรียน 5 คน: รหัส 65001 - 65005)'
    });
  } catch (error) {
    console.error('seed error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการใส่ข้อมูลจำลอง: ' + error.message });
  }
});

// 8. API สำหรับเพิ่มโหวตจำลองโดยแอดมิน
app.post('/api/admin/add-votes', verifyAdminPassword, async (req, res) => {
  const { candidate_id, count } = req.body;
  const voteCount = parseInt(count, 10);
  if (isNaN(voteCount) || voteCount <= 0) {
    return res.status(400).json({ error: 'จำนวนโหวตต้องมากกว่า 0' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let i = 0; i < voteCount; i++) {
      // 1. ลองหาคนเรียนที่ยังไม่ได้โหวต
      const findStudent = await client.query(
        'SELECT student_id FROM students WHERE has_voted = FALSE LIMIT 1'
      );
      if (findStudent.rows.length > 0) {
        // อัปเดตสถานะเป็นโหวตแล้ว
        await client.query(
          'UPDATE students SET has_voted = TRUE WHERE student_id = $1',
          [findStudent.rows[0].student_id]
        );
      } else {
        // ถ้าไม่มีนักเรียนเหลืออยู่ ให้สร้างนักเรียนจำลองขึ้นมาใหม่
        const mockId = `SIM-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        await client.query(
          "INSERT INTO students (student_id, name, surname, has_voted) VALUES ($1, 'จำลอง', 'ผู้ใช้สิทธิ์', TRUE)",
          [mockId]
        );
      }

      // 2. บันทึกคะแนนโหวต (ถ้า candidate_id เป็น null หรือ '' ให้โหวตเป็น NULL ใน DB)
      const candId = (candidate_id === null || candidate_id === '' || candidate_id === undefined) ? null : parseInt(candidate_id, 10);
      await client.query(
        "INSERT INTO votes (candidate_id, vote_type) VALUES ($1, 'onsite')",
        [candId]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `เพิ่มคะแนนจำลองจำนวน ${voteCount} เสียงเรียบร้อยแล้ว` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('add-votes error:', error);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการเพิ่มคะแนนจำลอง: ' + error.message });
  } finally {
    client.release();
  }
});

// เริ่มต้นฐานข้อมูลเมื่อเปิดเซิร์ฟเวอร์
initDatabase();

// เริ่มเปิดให้บริการเว็บเซิร์ฟเวอร์
app.listen(PORT, () => {
  console.log(`🚀 เซิร์ฟเวอร์ SME Vote ทำงานแล้วที่ http://localhost:${PORT}`);
});
