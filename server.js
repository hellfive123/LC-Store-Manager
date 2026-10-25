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

// 4. Xóa — trả lại dòng vừa xóa để client có thể hoàn tác
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        // created_at_raw: giờ gốc dạng text của Postgres, khôi phục không bị lệch múi giờ khi qua JS
        const { rows } = await runQuery(
            "DELETE FROM transactions WHERE id = $1 RETURNING *, created_at::text AS created_at_raw",
            [req.params.id]
        );
        res.json({ success: true, deleted: rows[0] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4b. Hoàn tác xóa: chèn lại đúng dòng cũ (giữ id, ngày tạo, trạng thái chốt)
app.post('/api/transactions/restore', async (req, res) => {
    const t = req.body || {};
    if (!Number.isInteger(t.id) || typeof t.created_at_raw !== 'string' || !t.created_at_raw) {
        return res.status(400).json({ error: 'Dữ liệu khôi phục không hợp lệ' });
    }
    try {
        await runQuery(
            `INSERT INTO transactions (id, cost, price, note, created_at, is_archived, status, settlement_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [t.id, t.cost, t.price, t.note, t.created_at_raw, t.is_archived ?? null, t.status ?? 'sold', t.settlement_id ?? null]
        );
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

// 8. Số liệu tổng (KPI + biểu đồ) tính trên TOÀN BỘ bảng, không bị LIMIT 500 cắt
// Client gửi mốc đầu ngày / đầu tháng / đầu 14 ngày theo giờ của trình duyệt (ISO)
app.get('/api/stats', async (req, res) => {
    const { day, month, since } = req.query;
    const valid = [day, month, since].every(v => v && !isNaN(Date.parse(v)));
    if (!valid) return res.status(400).json({ error: 'Thiếu mốc thời gian' });
    try {
        const sql = `
            SELECT
                COALESCE(SUM(price - cost) FILTER (WHERE created_at >= $1), 0) AS today,
                COALESCE(SUM(price - cost) FILTER (WHERE created_at >= $2), 0) AS month,
                COALESCE(SUM(price - cost), 0)                                 AS all_time,
                COALESCE(SUM(price - cost) FILTER (WHERE settlement_id IS NULL), 0) AS open,
                COALESCE(SUM(cost) FILTER (WHERE settlement_id IS NULL), 0)         AS open_cost,
                COUNT(*) FILTER (WHERE settlement_id IS NULL)                        AS open_count
            FROM transactions
        `;
        const { rows: [s] } = await runQuery(sql, [day, month]);
        const { rows: recent } = await runQuery(
            "SELECT created_at, price - cost AS profit FROM transactions WHERE created_at >= $1",
            [since]
        );
        res.json({ data: s, recent });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 9. Thống kê theo tháng (giờ Việt Nam), 12 tháng gần nhất, kèm ngày bán tốt nhất mỗi tháng
app.get('/api/monthly', async (req, res) => {
    try {
        const sql = `
            WITH d AS (
                SELECT created_at::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh' AS vn, cost, price
                FROM transactions
            ),
            days AS (
                SELECT date_trunc('day', vn) AS day, SUM(price - cost) AS profit
                FROM d GROUP BY 1
            ),
            best AS (
                SELECT DISTINCT ON (date_trunc('month', day)) date_trunc('month', day) AS month, day, profit
                FROM days ORDER BY date_trunc('month', day), profit DESC
            )
            SELECT to_char(date_trunc('month', d.vn), 'YYYY-MM') AS month,
                   COUNT(*)                            AS tx_count,
                   SUM(d.price)                        AS revenue,
                   SUM(d.cost)                         AS cost,
                   SUM(d.price - d.cost)               AS profit,
                   COUNT(DISTINCT date_trunc('day', d.vn)) AS active_days,
                   to_char(b.day, 'YYYY-MM-DD')        AS best_day,
                   b.profit                            AS best_day_profit
            FROM d JOIN best b ON b.month = date_trunc('month', d.vn)
            GROUP BY 1, b.day, b.profit
            ORDER BY 1 DESC
            LIMIT 12
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