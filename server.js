const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// การตั้งค่า Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// การเชื่อมต่อฐานข้อมูล PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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
    const result = await pool.query(
      'SELECT student_id, name, surname, has_voted FROM students WHERE line_id = $1',
      [line_id]
    );

    if (result.rows.length > 0) {
      const voter = result.rows[0];
      return res.json({
        registered: true,
        has_voted: voter.has_voted,
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

// 6. ดึงสถิติผลคะแนนรวม (Real-time) สำหรับ Admin Dashboard
app.get('/api/results', async (req, res) => {
  try {
    // 1. ดึงคะแนนแยกแต่ละผู้สมัคร
    const candidateVotesQuery = `
      SELECT c.id, c.candidate_number, c.name, c.surname, COUNT(v.id) AS vote_count
      FROM candidates c
      LEFT JOIN votes v ON c.id = v.candidate_id
      GROUP BY c.id, c.candidate_number, c.name, c.surname
      ORDER BY c.candidate_number ASC
    `;
    const candidateVotes = await pool.query(candidateVotesQuery);

    // 2. ดึงจำนวนโหวต "ไม่ประสงค์ลงคะแนน" (No Vote)
    const noVotesQuery = 'SELECT COUNT(*) AS no_vote_count FROM votes WHERE candidate_id IS NULL';
    const noVotes = await pool.query(noVotesQuery);

    // 3. ดึงสถิติการใช้สิทธิ์ของนักเรียนทั้งหมด
    const statsQuery = `
      SELECT 
        COUNT(*) AS total_eligible,
        SUM(CASE WHEN has_voted = TRUE THEN 1 ELSE 0 END) AS total_voted,
        SUM(CASE WHEN has_voted = FALSE THEN 1 ELSE 0 END) AS total_not_voted
      FROM students
    `;
    const stats = await pool.query(statsQuery);

    const statsData = stats.rows[0];

    res.json({
      candidates: candidateVotes.rows.map(row => ({
        id: row.id,
        candidate_number: row.candidate_number,
        name: `${row.name} ${row.surname}`,
        votes: parseInt(row.vote_count, 10)
      })),
      no_vote_count: parseInt(noVotes.rows[0].no_vote_count, 10),
      summary: {
        total_eligible: parseInt(statsData.total_eligible, 10) || 0,
        total_voted: parseInt(statsData.total_voted, 10) || 0,
        total_not_voted: parseInt(statsData.total_not_voted, 10) || 0,
        voted_percentage: statsData.total_eligible > 0 
          ? ((statsData.total_voted / statsData.total_eligible) * 100).toFixed(2)
          : "0.00"
      }
    });
  } catch (error) {
    console.error('results error:', error);
    res.status(500).json({ error: 'ไม่สามารถดึงผลสถิติคะแนนโหวตได้' });
  }
});

// 7. API สำหรับ Seed ข้อมูลจำลอง (ผู้สมัคร 3 คน และสิทธิ์นักเรียน 5 คน)
app.post('/api/seed', async (req, res) => {
  try {
    // ตรวจสอบและรัน DDL Schema ก่อน
    await initDatabase();

    // ล้างข้อมูลเก่า
    await pool.query('TRUNCATE votes, students, candidates RESTART IDENTITY CASCADE');

    // ใส่ข้อมูลผู้สมัคร (Candidates)
    const seedCandidates = [
      [1, 'พรรคภูมิใจเทอ', '', 'พรรคเพื่อการพัฒนาโรงเรียนและสร้างความสร้างสรรค์ในหมู่นักเรียน', 'https://smevote.vercel.app/group1.jpg'],
      [2, 'พรรค MORROW', '', 'กลุ่มนักเรียนรุ่นใหม่ เพื่อวันพรุ่งนี้ที่ดีกว่าสำหรับชาว SME', 'https://smevote.vercel.app/group2.jpg']
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

// เริ่มต้นฐานข้อมูลเมื่อเปิดเซิร์ฟเวอร์
initDatabase();

// เริ่มเปิดให้บริการเว็บเซิร์ฟเวอร์
app.listen(PORT, () => {
  console.log(`🚀 เซิร์ฟเวอร์ SME Vote ทำงานแล้วที่ http://localhost:${PORT}`);
});
