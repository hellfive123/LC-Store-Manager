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
            LIMIT 500
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

// 6. Xóa toàn bộ giao dịch của một tháng
app.post('/api/delete-month', async (req, res) => {
    const month = Number(req.body.month);
    const year = Number(req.body.year);
    if (!month || !year) return res.status(400).json({ error: 'Thiếu tháng hoặc năm' });
    try {
        const result = await runQuery(
            `DELETE FROM transactions
             WHERE EXTRACT(MONTH FROM created_at) = $1 AND EXTRACT(YEAR FROM created_at) = $2`,
            [month, year]
        );
        res.json({ success: true, deleted: result.rowCount });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 7. Lịch sử các đợt chốt sổ (gộp theo settlement_id)
app.get('/api/settlements', async (req, res) => {
    try {
        const sql = `
            SELECT settlement_id,
                   COUNT(*)           AS tx_count,
                   SUM(cost)          AS total_cost,
                   SUM(price)         AS total_price,
                   SUM(price - cost)  AS total_profit,
                   MIN(created_at)    AS from_date,
                   MAX(created_at)    AS to_date
            FROM transactions
            WHERE settlement_id IS NOT NULL
            GROUP BY settlement_id
            ORDER BY settlement_id DESC
        `;
        const { rows } = await runQuery(sql);
        res.json({ data: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Route mặc định
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;