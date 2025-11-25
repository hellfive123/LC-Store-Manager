// server.js - Phiên bản Vercel + Neon
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
// Phục vụ file giao diện từ thư mục public
app.use(express.static(path.join(__dirname, 'public')));

// Kết nối Database Neon
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // Biến này sẽ cài trên Vercel
    ssl: { rejectUnauthorized: false }
});

// Hàm tạo bảng (Chạy mỗi khi server khởi động để chắc chắn bảng tồn tại)
const initDB = async () => {
    try {
        const client = await pool.connect();
        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                cost REAL,
                price REAL,
                note TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_archived INTEGER DEFAULT 0,
                status TEXT DEFAULT 'sold'
            );
        `);
        client.release();
        console.log("DB Checked/Created");
    } catch (err) {
        console.error("DB Error:", err);
    }
};
initDB();

// Helper chạy query
const runQuery = async (text, params) => {
    const client = await pool.connect();
    try {
        const res = await client.query(text, params);
        return res;
    } finally {
        client.release();
    }
};

// --- CÁC API ---

app.get('/api/transactions', async (req, res) => {
    try {
        const { rows } = await runQuery("SELECT * FROM transactions WHERE is_archived = 0 ORDER BY created_at DESC");
        res.json({ data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/transactions', async (req, res) => {
    const { cost, price, note } = req.body;
    try {
        // Postgres dùng $1, $2... thay vì ?
        await runQuery(
            "INSERT INTO transactions (cost, price, note, status, is_archived) VALUES ($1, $2, $3, 'sold', 0)", 
            [cost, price, note]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/transactions/:id', async (req, res) => {
    const { cost, price, note } = req.body;
    try {
        await runQuery(
            "UPDATE transactions SET cost = $1, price = $2, note = $3 WHERE id = $4",
            [cost, price, note, req.params.id]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/transactions/:id', async (req, res) => {
    try {
        await runQuery("DELETE FROM transactions WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/delete-month', async (req, res) => {
    const { month, year } = req.body;
    const dateStr = `${year}-${month}`;
    try {
        await runQuery("DELETE FROM transactions WHERE TO_CHAR(created_at, 'YYYY-MM') = $1", [dateStr]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settle', async (req, res) => {
    const { date } = req.body; // Nhận ngày từ Client (dạng '2025-11-25')
    
    if (!date) return res.status(400).json({ error: "Thiếu ngày chốt sổ" });

    try {
        // Postgres: Cộng 7 tiếng để đổi UTC sang giờ VN, sau đó so sánh ngày
        const sql = `
            UPDATE transactions 
            SET is_archived = 1 
            WHERE is_archived = 0 
            AND TO_CHAR(created_at + interval '7 hours', 'YYYY-MM-DD') = $1
        `;
        const result = await runQuery(sql, [date]);
        res.json({ success: true, changes: result.rowCount });
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});

// Route mặc định trả về index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Xuất app để Vercel sử dụng (Quan trọng)
module.exports = app;