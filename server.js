// server.js - Phiên bản chạy Cloud (Neon + Vercel)
const express = require('express');
const { Pool } = require('pg'); // Dùng thư viện pg thay vì sqlite3
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Lấy chuỗi kết nối từ biến môi trường (Cấu hình sau trên Vercel)
// Nếu chạy local để test thì bạn thay chuỗi connection string của bạn vào dấu '' bên dưới
const connectionString = process.env.DATABASE_URL || ''; 

const pool = new Pool({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false } // Bắt buộc cho Neon
});

// Tạo bảng nếu chưa có (Dùng cú pháp PostgreSQL)
const initDB = async () => {
    const client = await pool.connect();
    try {
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
        console.log("Database connected & checked!");
    } catch (err) {
        console.error("Error initializing DB:", err);
    } finally {
        client.release();
    }
};
initDB();

// API Helper: Thực hiện query an toàn
const runQuery = async (query, params = []) => {
    const client = await pool.connect();
    try {
        const result = await client.query(query, params);
        return result;
    } finally {
        client.release();
    }
};

// --- CÁC API ---

// 1. Lấy danh sách
app.get('/api/transactions', async (req, res) => {
    try {
        const result = await runQuery("SELECT * FROM transactions WHERE is_archived = 0 ORDER BY created_at DESC");
        res.json({ data: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Thêm mới
app.post('/api/transactions', async (req, res) => {
    const { cost, price, note } = req.body;
    try {
        // Postgres dùng $1, $2 thay vì ?
        const sql = `INSERT INTO transactions (cost, price, note, status, is_archived) VALUES ($1, $2, $3, 'sold', 0) RETURNING id`;
        const result = await runQuery(sql, [cost, price, note]);
        res.json({ id: result.rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Sửa
app.put('/api/transactions/:id', async (req, res) => {
    const { cost, price, note } = req.body;
    try {
        const sql = `UPDATE transactions SET cost = $1, price = $2, note = $3 WHERE id = $4`;
        await runQuery(sql, [cost, price, note, req.params.id]);
        res.json({ message: "Updated" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Xóa 1 dòng
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        await runQuery(`DELETE FROM transactions WHERE id = $1`, [req.params.id]);
        res.json({ message: "Deleted" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. Xóa theo tháng (Postgres dùng TO_CHAR thay vì strftime)
app.post('/api/delete-month', async (req, res) => {
    const { month, year } = req.body; // month: '11', year: '2025'
    const dateStr = `${year}-${month}`;
    try {
        const sql = `DELETE FROM transactions WHERE TO_CHAR(created_at, 'YYYY-MM') = $1`;
        const result = await runQuery(sql, [dateStr]);
        res.json({ changes: result.rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 6. Chốt sổ
app.post('/api/settle', async (req, res) => {
    try {
        const result = await runQuery(`UPDATE transactions SET is_archived = 1 WHERE is_archived = 0`);
        res.json({ changes: result.rowCount });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});