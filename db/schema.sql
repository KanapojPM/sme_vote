-- ตารางข้อมูลผู้สมัครกรรมการนักเรียน
CREATE TABLE IF NOT EXISTS candidates (
    id SERIAL PRIMARY KEY,
    candidate_number INTEGER NOT NULL UNIQUE, -- หมายเลขผู้สมัคร (เช่น เบอร์ 1, เบอร์ 2)
    name VARCHAR(100) NOT NULL,              -- ชื่อผู้สมัคร
    surname VARCHAR(100) NOT NULL,           -- นามสกุลผู้สมัคร
    policy TEXT NOT NULL,                    -- นโยบายหาเสียง
    image_url VARCHAR(255)                   -- ลิงก์รูปภาพผู้สมัคร
);

-- ตารางสิทธิ์ของนักเรียนและสถานะการโหวต
CREATE TABLE IF NOT EXISTS students (
    student_id VARCHAR(50) PRIMARY KEY,       -- รหัสนักเรียน (คีย์หลักใช้ระบุสิทธิ์)
    name VARCHAR(100) NOT NULL,               -- ชื่อนักเรียน
    surname VARCHAR(100) NOT NULL,            -- นามสกุลนักเรียน
    line_id VARCHAR(255) UNIQUE,              -- LINE User ID ที่ดึงมาจาก LINE LIFF (ผูกตอนเข้าใช้ครั้งแรก)
    has_voted BOOLEAN DEFAULT FALSE NOT NULL  -- สถานะการใช้สิทธิ์ (TRUE = โหวตแล้ว, FALSE = ยังไม่ได้โหวต)
);

-- ตารางคะแนนโหวต (ออกแบบมาให้ "ไม่ระบุตัวตน" เพื่อความเป็นธรรมและเป็นความลับ)
-- จะไม่มี Foreign Key โยงไปยังตาราง students เพื่อไม่ให้รู้ว่านักเรียนคนไหนโหวตให้ใคร
CREATE TABLE IF NOT EXISTS votes (
    id SERIAL PRIMARY KEY,
    candidate_id INTEGER REFERENCES candidates(id) ON DELETE SET NULL, -- ID ผู้สมัคร (เป็น NULL ได้ กรณี "ไม่ประสงค์ลงคะแนน")
    vote_type VARCHAR(10) DEFAULT 'online' NOT NULL,                   -- ประเภทการโหวต ('online' หรือ 'onsite')
    voted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL              -- วันเวลาที่ลงคะแนน
);

-- สร้าง Index บน candidate_id เพื่อความเร็วในการรันคำสั่งสรุปผลคะแนน
CREATE INDEX IF NOT EXISTS idx_votes_candidate_id ON votes(candidate_id);

-- ตารางการตั้งค่าระบบ (สำหรับระบุจำนวนนักเรียน หรือสถิติที่กำหนดโดยแอดมิน)
CREATE TABLE IF NOT EXISTS system_settings (
    key VARCHAR(50) PRIMARY KEY,
    value VARCHAR(255) NOT NULL
);

-- ใส่ค่าเริ่มต้นสำหรับจำนวนผู้มีสิทธิ์เลือกตั้งทั้งหมด (ถ้ายังไม่มี)
INSERT INTO system_settings (key, value) VALUES ('total_students', '100') ON CONFLICT DO NOTHING;
