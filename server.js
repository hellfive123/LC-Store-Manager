// server.js - Phiên bản Reset tiền nhưng giữ lịch sử
const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

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

// 1. Lấy danh sách: Lấy TẤT CẢ giao dịch (để hiện lịch sử)
// Sắp xếp: Cái nào chưa chốt (settlement_id IS NULL) lên đầu, sau đó đến ngày tháng
app.get('/api/transactions', async (req, res) => {
    try {
        const sql = `
            SELECT * FROM transactions 
            ORDER BY 
                CASE WHEN settlement_id IS NULL THEN 0 ELSE 1 END, 
                created_at DESC
            LIMIT 100 -- Giới hạn 100 dòng cho nhẹ, hoặc bỏ dòng này nếu muốn lấy hết
        `;
        const { rows } = await runQuery(sql);
        res.json({ data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. Thêm mới
app.post('/api/transactions', async (req, res) => {
    const { cost, price, note } = req.body;
    try {
        // settlement_id mặc định là NULL (chưa chốt)
        await runQuery(
            "INSERT INTO transactions (cost, price, note, status) VALUES ($1, $2, $3, 'sold')", 
            [cost, price, note]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Sửa
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

// 4. Xóa
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        await runQuery("DELETE FROM transactions WHERE id = $1", [req.params.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. CHỐT SỔ (Reset tiền về 0)
// Logic: Tìm tất cả các dòng chưa chốt (settlement_id là NULL) và gán cho nó một ID mới
app.post('/api/settle', async (req, res) => {
    try {
        // Tạo một mã chốt sổ ngẫu nhiên (dựa trên thời gian)
        const newSettlementId = Math.floor(Date.now() / 1000);
        
        const sql = `
            UPDATE transactions 
            SET settlement_id = $1 
            WHERE settlement_id IS NULL
        `;
        const result = await runQuery(sql, [newSettlementId]);
        res.json({ success: true, changes: result.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Route mặc định
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;