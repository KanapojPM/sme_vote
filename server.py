import os
import logging
from typing import Optional, List, Dict, Any
from contextlib import contextmanager

from fastapi import FastAPI, HTTPException, status, Query, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import psycopg2
from psycopg2.pool import SimpleConnectionPool
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

# โหลดค่าตั้งค่าจากไฟล์ .env
load_dotenv()

PORT = int(os.getenv("PORT", "3000"))
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/sme_vote")
LIFF_ID = os.getenv("LIFF_ID", "mock-liff-id-12345")

# ตั้งค่า Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sme_vote")

app = FastAPI(
    title="SME Vote API",
    description="ระบบจัดการลงคะแนนเลือกตั้งกรรมการนักเรียน SME Vote",
    version="1.0.0"
)

# การเปิดใช้งาน CORS ให้กับ Frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# เริ่มต้นระบบ Connection Pool สำหรับ PostgreSQL
try:
    db_pool = SimpleConnectionPool(1, 10, dsn=DATABASE_URL)
    logger.info("✅ เชื่อมต่อฐานข้อมูลและสร้าง Connection Pool สำเร็จ")
except Exception as e:
    logger.error(f"❌ ไม่สามารถสร้าง Connection Pool ได้: {e}")
    db_pool = None

# Context Manager สำหรับขอยืมการเชื่อมต่อจาก Pool อย่างปลอดภัย
@contextmanager
def get_db_conn():
    if not db_pool:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="ระบบติดต่อฐานข้อมูลไม่ได้เชื่อมต่อในขณะนี้"
        )
    conn = db_pool.getconn()
    conn.autocommit = False # ตั้งค่าเป็น False เพื่อให้ใช้งานระบบ Transaction ได้ถูกต้อง
    try:
        yield conn
    except Exception as e:
        conn.rollback() # ม้วนกลับหากมีข้อผิดพลาดระหว่างทาง
        raise e
    finally:
        db_pool.putconn(conn)

# ฟังก์ชันอ่านไฟล์ Schema เพื่อสร้างตารางอัตโนมัติเมื่อระบบเริ่มทำงาน
def init_db():
    if not db_pool:
        return
    
    schema_path = os.path.join(os.path.dirname(__file__), 'db', 'schema.sql')
    if not os.path.exists(schema_path):
        logger.warning(f"⚠️ ไม่พบไฟล์ schema ที่เส้นทาง: {schema_path}")
        return

    try:
        with db_pool.getconn() as conn:
            conn.autocommit = True
            with conn.cursor() as cur:
                with open(schema_path, 'r', encoding='utf-8') as f:
                    sql_content = f.read()
                    cur.execute(sql_content)
            db_pool.putconn(conn)
            logger.info("✅ ตรวจสอบและรัน Database Schema เรียบร้อยแล้ว")
    except Exception as e:
        logger.error(f"❌ เกิดข้อผิดพลาดในการติดตั้งโครงสร้างตาราง: {e}")

# ----------------------------------------------------
# Pydantic Schemas สำหรับตรวจสอบข้อมูลรับเข้า (Data Validation)
# ----------------------------------------------------
class RegisterRequest(BaseModel):
    line_id: str
    student_id: str

class VoteRequest(BaseModel):
    line_id: str
    candidate_id: Optional[int] = None # เป็น None ได้ในกรณีไม่ประสงค์ลงคะแนน

# ----------------------------------------------------
# API Endpoints
# ----------------------------------------------------

# 1. ดึงข้อมูล Config สำหรับ Frontend (เช่น LIFF ID)
@app.get("/api/config")
def get_config():
    return {"liffId": LIFF_ID}

# 2. ตรวจสอบสถานะและลงทะเบียนอัตโนมัติด้วย LINE User ID ทันทีที่ใช้งานครั้งแรก
@app.get("/api/voter-status")
def get_voter_status(
    line_id: str = Query(..., description="LINE User ID ที่ต้องการตรวจสอบ"),
    name: Optional[str] = Query(None, description="ชื่อโปรไฟล์ LINE เพื่อลงทะเบียนอัตโนมัติ")
):
    if not line_id:
        raise HTTPException(status_code=400, detail="กรุณาระบุ line_id")
        
    with get_db_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT student_id, name, surname, has_voted FROM students WHERE line_id = %s",
                (line_id,)
            )
            row = cur.fetchone()
            
            if row:
                return {
                    "registered": True,
                    "has_voted": row["has_voted"],
                    "student": {
                        "student_id": row["student_id"],
                        "name": row["name"],
                        "surname": row["surname"]
                    }
                }
            else:
                # หากไม่พบข้อมูลสิทธิ์ ให้ทำการเพิ่มสิทธิ์ให้ LINE User ID นี้ในระบบโดยอัตโนมัติทันที
                display_name = name if name else "ผู้ใช้ LINE"
                student_id = line_id[:50] # ใช้ LINE ID เป็นรหัสสิทธิ์
                
                try:
                    cur.execute(
                        "INSERT INTO students (student_id, line_id, name, surname) VALUES (%s, %s, %s, %s)",
                        (student_id, line_id, display_name, "")
                    )
                    conn.commit()
                    
                    return {
                        "registered": True,
                        "has_voted": False,
                        "student": {
                            "student_id": student_id,
                            "name": display_name,
                            "surname": ""
                        }
                    }
                except Exception as db_err:
                    conn.rollback()
                    logger.error(f"Auto-register error: {db_err}")
                    raise HTTPException(status_code=500, detail="ไม่สามารถสร้างบัญชีผู้สิทธิ์โหวตอัตโนมัติได้")

# 3. ผูกรหัสนักเรียนกับ LINE User ID
@app.post("/api/register")
def register_student(req: RegisterRequest):
    with get_db_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # 1. ตรวจสอบว่ารหัสนักเรียนนี้มีตัวตนในฐานข้อมูลหรือไม่
            cur.execute(
                "SELECT student_id, name, surname, line_id FROM students WHERE student_id = %s",
                (req.student_id,)
            )
            student = cur.fetchone()
            
            if not student:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="ไม่พบรหัสนักเรียนนี้ในระบบ หรือไม่ได้รับสิทธิ์เลือกตั้ง"
                )
                
            # 2. ตรวจสอบว่ารหัสนักเรียนนี้ถูกผูกเข้ากับ LINE อื่นแล้วหรือยัง
            if student["line_id"] and student["line_id"] != req.line_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="รหัสนักเรียนนี้ถูกผูกเข้ากับบัญชี LINE อื่นเรียบร้อยแล้ว"
                )
                
            # 3. ตรวจสอบว่า LINE บัญชีนี้ถูกใช้ผูกกับรหัสนักเรียนอื่นไปแล้วหรือไม่
            cur.execute(
                "SELECT student_id FROM students WHERE line_id = %s",
                (req.line_id,)
            )
            line_check = cur.fetchone()
            
            if line_check and line_check["student_id"] != req.student_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="บัญชี LINE นี้ผูกสิทธิ์เข้ากับรหัสนักเรียนอื่นไปแล้ว"
                )
                
            # 4. บันทึกข้อมูลการผูกสิทธิ์
            cur.execute(
                "UPDATE students SET line_id = %s WHERE student_id = %s",
                (req.line_id, req.student_id)
            )
            conn.commit()
            
            return {
                "success": True,
                "message": "ลงทะเบียนผูกสิทธิ์สำเร็จ",
                "student": {
                    "student_id": student["student_id"],
                    "name": student["name"],
                    "surname": student["surname"]
                }
            }

# 4. ดึงข้อมูลรายชื่อผู้สมัครรับเลือกตั้ง
@app.get("/api/candidates")
def get_candidates():
    with get_db_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT id, candidate_number, name, surname, policy, image_url FROM candidates ORDER BY candidate_number ASC"
            )
            return cur.fetchall()

# 5. ลงคะแนนโหวต (ระบบความปลอดภัยสูงสุด ป้องกัน Double Vote ด้วย DB Transactions และ Row Locking)
@app.post("/api/vote")
def cast_vote(req: VoteRequest):
    with get_db_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # 1. ล็อคแถวข้อมูลของนักเรียนเพื่ออัปเดตและป้องกันการยิง API ซ้ำซ้อน (Race Condition)
            cur.execute(
                "SELECT student_id, has_voted FROM students WHERE line_id = %s FOR UPDATE",
                (req.line_id,)
            )
            voter = cur.fetchone()
            
            if not voter:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="คุณไม่มีสิทธิ์ในการลงคะแนน (กรุณาลงทะเบียนก่อน)"
                )
                
            # 2. ตรวจสอบว่ามีการลงคะแนนซ้ำหรือไม่
            if voter["has_voted"]:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="คุณได้ลงคะแนนโหวตเรียบร้อยแล้ว ไม่สามารถโหวตซ้ำได้"
                )
                
            # 3. ตรวจสอบว่าหมายเลขผู้สมัครที่จะโหวตมีจริงหรือไม่ (กรณีไม่ได้เป็นบัตรเสีย/ไม่ประสงค์ลงคะแนน)
            if req.candidate_id is not None:
                cur.execute(
                    "SELECT id FROM candidates WHERE id = %s",
                    (req.candidate_id,)
                )
                if not cur.fetchone():
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="ไม่พบหมายเลขผู้สมัครที่คุณเลือกโหวต"
                    )
            
            # 4. บันทึกผลคะแนนโหวตลงในกล่องบัตร (ไม่มีข้อมูล student_id เชื่อมโยง เพื่อความลับสูงสุด)
            cur.execute(
                "INSERT INTO votes (candidate_id) VALUES (%s)",
                (req.candidate_id,)
            )
            
            # 5. อัปเดตสถานะของนักเรียนว่า "ใช้สิทธิ์โหวตแล้ว"
            cur.execute(
                "UPDATE students SET has_voted = TRUE WHERE line_id = %s",
                (req.line_id,)
            )
            
            # ยืนยันการเปลี่ยนแปลงข้อมูลแบบ Transaction ปลอดภัยไร้กังวล
            conn.commit()
            
            return {
                "success": True,
                "message": "บันทึกคะแนนโหวตเรียบร้อยแล้ว ขอขอบพระคุณที่ใช้สิทธิ์"
            }

# 6. ดึงผลคะแนนรวม Real-time สำหรับระบบแดชบอร์ดแอดมิน
@app.get("/api/results")
def get_results():
    with get_db_conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # ดึงคะแนนเสียงที่ผู้สมัครแต่ละคนได้รับ
            cur.execute("""
                SELECT c.id, c.candidate_number, c.name, c.surname, COUNT(v.id) AS vote_count
                FROM candidates c
                LEFT JOIN votes v ON c.id = v.candidate_id
                GROUP BY c.id, c.candidate_number, c.name, c.surname
                ORDER BY c.candidate_number ASC
            """)
            candidate_votes = cur.fetchall()
            
            # ดึงคะแนนที่ไม่ประสงค์ลงคะแนน
            cur.execute("SELECT COUNT(*) AS no_vote_count FROM votes WHERE candidate_id IS NULL")
            no_vote = cur.fetchone()
            no_vote_count = no_vote["no_vote_count"] if no_vote else 0
            
            # ดึงสถิติรวมของนักเรียน
            cur.execute("""
                SELECT 
                    COUNT(*) AS total_eligible,
                    SUM(CASE WHEN has_voted = TRUE THEN 1 ELSE 0 END) AS total_voted,
                    SUM(CASE WHEN has_voted = FALSE THEN 1 ELSE 0 END) AS total_not_voted
                FROM students
            """)
            stats = cur.fetchone()
            
            total_eligible = stats["total_eligible"] if stats else 0
            total_voted = stats["total_voted"] if stats else 0
            total_not_voted = stats["total_not_voted"] if stats else 0
            
            voted_percentage = "0.00"
            if total_eligible > 0:
                voted_percentage = f"{((total_voted / total_eligible) * 100):.2f}"
                
            return {
                "candidates": [
                    {
                        "id": row["id"],
                        "candidate_number": row["candidate_number"],
                        "name": f"{row['name']} {row['surname']}",
                        "votes": row["vote_count"]
                    }
                    for row in candidate_votes
                ],
                "no_vote_count": no_vote_count,
                "summary": {
                    "total_eligible": total_eligible,
                    "total_voted": total_voted,
                    "total_not_voted": total_not_voted,
                    "voted_percentage": voted_percentage
                }
            }

# 7. Endpoint จำลองสิทธิ์นักเรียน 5 คน และผู้สมัคร 3 คน (Seed Data)
@app.post("/api/seed")
def seed_data():
    # ตรวจสอบโครงสร้าง DDL ก่อนทำ
    init_db()
    
    with get_db_conn() as conn:
        with conn.cursor() as cur:
            # ล้างข้อมูลเดิมทั้งหมดในตารางที่เกี่ยวข้อง
            cur.execute("TRUNCATE votes, students, candidates RESTART IDENTITY CASCADE")
            
            # 1. ใส่ข้อมูลผู้สมัครรับเลือกตั้ง 2 รายชื่อจริง
            candidates = [
                (1, 'พรรคภูมิใจเทอ', '', 'พรรคเพื่อการพัฒนาโรงเรียนและสร้างความสร้างสรรค์ในหมู่นักเรียน', 'https://smevote.vercel.app/group1.jpg'),
                (2, 'พรรค MORROW', '', 'กลุ่มนักเรียนรุ่นใหม่ เพื่อวันพรุ่งนี้ที่ดีกว่าสำหรับชาว SME', 'https://smevote.vercel.app/group2.jpg')
            ]
            
            cur.executemany(
                "INSERT INTO candidates (candidate_number, name, surname, policy, image_url) VALUES (%s, %s, %s, %s, %s)",
                candidates
            )
            
            # 2. ใส่ข้อมูลนักเรียนที่มีสิทธิ์ทดลองลงทะเบียน 5 คน
            students = [
                ('65001', 'กิตติ', 'รักเรียน'),
                ('65002', 'ศิริ', 'งามตา'),
                ('65003', 'วิชัย', 'ประเสริฐยิ่ง'),
                ('65004', 'มณี', 'ศรีสวัสดิ์'),
                ('65005', 'สมพร', 'ดีงาม')
            ]
            
            cur.executemany(
                "INSERT INTO students (student_id, name, surname) VALUES (%s, %s, %s)",
                students
            )
            
            conn.commit()
            
            return {
                "success": True,
                "message": "สร้างตารางและจำลองสิทธิ์นักเรียน 5 คน (65001-65005) และรายชื่อผู้สมัคร 2 คน เรียบร้อยแล้ว!"
            }

# ----------------------------------------------------
# ให้บริการไฟล์หน้าเว็บ Static (Frontend) จากโฟลเดอร์ public
# ----------------------------------------------------
# ข้อสำคัญ: ต้อง mount หลังจากระบุเส้นทาง API แล้ว เพื่อป้องกันไม่ให้ถูกแย่งเส้นทาง
app.mount("/", StaticFiles(directory="public", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    # เปิดใช้งาน uvicorn รันเซิร์ฟเวอร์บน Port 3000
    init_db() # เรียกใช้ตรวจสอบ DDL
    logger.info(f"🚀 เซิร์ฟเวอร์ FastAPI พร้อมเปิดบริการที่ http://localhost:{PORT}")
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, reload=True)
