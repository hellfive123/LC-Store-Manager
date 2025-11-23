const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Kết nối Database và tự động tạo bảng/cột nếu thiếu
const db = new sqlite3.Database('./sales.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to SQLite database.');

    const createTable = `CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cost REAL,
        price REAL,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_archived INTEGER DEFAULT 0 
    )`;

    db.run(createTable, (err) => {
        if (!err) {
            // Cố gắng thêm cột is_archived cho các db cũ (nếu chưa có)
            db.run(`ALTER TABLE transactions ADD COLUMN is_archived INTEGER DEFAULT 0`, () => {});
        }
    });
});

// API: Lấy danh sách (chỉ lấy cái chưa chốt sổ)
app.get('/api/transactions', (req, res) => {
    db.all("SELECT * FROM transactions WHERE is_archived = 0 ORDER BY created_at DESC", [], (err, rows) => {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ data: rows });
    });
});

// API: Thêm mới
app.post('/api/transactions', (req, res) => {
    const { cost, price, note } = req.body;
    const sql = `INSERT INTO transactions (cost, price, note, is_archived) VALUES (?, ?, ?, 0)`;
    db.run(sql, [cost, price, note], function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ id: this.lastID });
    });
});

// API: Sửa
app.put('/api/transactions/:id', (req, res) => {
    const { cost, price, note } = req.body;
    db.run(`UPDATE transactions SET cost = ?, price = ?, note = ? WHERE id = ?`, 
        [cost, price, note, req.params.id], 
        function(err) {
            if (err) return res.status(400).json({ error: err.message });
            res.json({ message: "Updated" });
    });
});

// API: Xóa 1 dòng
app.delete('/api/transactions/:id', (req, res) => {
    db.run(`DELETE FROM transactions WHERE id = ?`, req.params.id, function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ message: "Deleted" });
    });
});

// API: Xóa theo tháng
app.post('/api/delete-month', (req, res) => {
    const { month, year } = req.body;
    const dateStr = `${year}-${month}`; 
    db.run(`DELETE FROM transactions WHERE strftime('%Y-%m', created_at) = ?`, [dateStr], function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ changes: this.changes });
    });
});

// API: Chốt sổ (Reset về 0)
app.post('/api/settle', (req, res) => {
    db.run(`UPDATE transactions SET is_archived = 1 WHERE is_archived = 0`, [], function(err) {
        if (err) return res.status(400).json({ error: err.message });
        res.json({ changes: this.changes });
    });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});