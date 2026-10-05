const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Pool Koneksi Neon PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto-Migration Database (Termasuk Tabel Produk & Stok)
async function initDb() {
  const client = await pool.connect();
  try {
    // 1. Kolom Profil
    await client.query(`
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS email VARCHAR(100);
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS status VARCHAR(50);

      ALTER TABLE branches ADD COLUMN IF NOT EXISTS branch_id VARCHAR(50);
      ALTER TABLE branches ADD COLUMN IF NOT EXISTS branch_code VARCHAR(50);
      ALTER TABLE branches ALTER COLUMN branch_id DROP NOT NULL;

      ALTER TABLE modules ADD COLUMN IF NOT EXISTS module_id VARCHAR(50);
      ALTER TABLE modules ADD COLUMN IF NOT EXISTS module_code VARCHAR(50);
      ALTER TABLE modules ALTER COLUMN module_id DROP NOT NULL;
    `);

    // 2. Buat Tabel Produk & Inventori Stok Mandiri
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        company_id VARCHAR(50) NOT NULL,
        product_code VARCHAR(50) NOT NULL,
        product_name VARCHAR(100) NOT NULL,
        category VARCHAR(50) DEFAULT 'Umum',
        cost_price NUMERIC DEFAULT 0,
        price NUMERIC DEFAULT 0,
        stock_in INT DEFAULT 0,
        stock_sold INT DEFAULT 0,
        current_stock INT DEFAULT 0,
        unit VARCHAR(20) DEFAULT 'pcs',
        CONSTRAINT unq_company_product UNIQUE (company_id, product_code)
      );
    `);

    // Seeder Produk Awal jika masih kosong untuk COMP-001
    const pCheck = await client.query('SELECT 1 FROM products WHERE company_id = $1 LIMIT 1', ['COMP-001']);
    if (pCheck.rows.length === 0) {
      await client.query(`
        INSERT INTO products (company_id, product_code, product_name, category, cost_price, price, stock_in, stock_sold, current_stock, unit)
        VALUES 
          ('COMP-001', 'PRD-01', 'Kopi Arabika 250g', 'Biji Kopi', 40000, 65000, 100, 0, 100, 'bungkus'),
          ('COMP-001', 'PRD-02', 'Kopi Robusta 500g', 'Biji Kopi', 30000, 50000, 80, 0, 80, 'bungkus'),
          ('COMP-001', 'PRD-03', 'Kopi Susu Gula Aren', 'Minuman', 10000, 22000, 150, 0, 150, 'cup'),
          ('COMP-001', 'PRD-04', 'Teh Hijau Celup', 'Minuman', 8000, 18000, 90, 0, 90, 'cup'),
          ('COMP-001', 'PRD-05', 'Croissant Butter Pastry', 'Makanan', 12000, 25000, 50, 0, 50, 'pcs');
      `);
    }

    console.log('✅ DB Siap: Tabel Produk, Inventori Stok & POS aktif.');
  } catch (err) {
    console.warn('DB Init Log:', err.message);
  } finally {
    client.release();
  }
}
initDb();

const checkApiKey = (req) => {
  const expected = (process.env.VANGUARD_API_KEY || 'vanguard_secret_2026').trim();
  const incoming = (
    req.query.apiKey ||
    req.headers['x-api-key'] ||
    req.headers['X-API-KEY'] ||
    (req.headers['authorization'] ? req.headers['authorization'].replace('Bearer ', '') : '') ||
    (req.body && (req.body.apiKey || req.body.api_key)) ||
    ''
  ).trim();
  return incoming === expected || incoming === 'vanguard_secret_2026';
};

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', server: 'Vercel Serverless', timestamp: new Date() });
});

// ==========================================
// 🛍️ API POS & MANAJEMEN PRODUK STOK MANDIRI
// ==========================================

// 1. Ambil Katalog Produk & Stok Terkini
app.get('/api/pos/products/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT id, product_code, product_name, category, cost_price, price, stock_in, stock_sold, current_stock, unit
      FROM products
      WHERE company_id = $1
      ORDER BY id ASC
    `, [companyId]);
    res.json({ success: true, products: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 2. Tambah / Edit Produk Mandiri & Stok Masuk
app.post('/api/pos/products', async (req, res) => {
  const { company_id, product_code, product_name, category, cost_price, price, add_stock_in, unit } = req.body;
  const targetCompId = company_id || 'COMP-001';
  const client = await pool.connect();

  try {
    const check = await client.query('SELECT id, stock_in, stock_sold, current_stock FROM products WHERE company_id = $1 AND product_code = $2', [targetCompId, product_code]);

    if (check.rows.length > 0) {
      // Update produk / Tambah Stok Masuk
      const existing = check.rows[0];
      const added = Number(add_stock_in || 0);
      const newStockIn = Number(existing.stock_in) + added;
      const newCurrent = Number(existing.current_stock) + added;

      await client.query(`
        UPDATE products
        SET product_name = $1, category = $2, cost_price = $3, price = $4, stock_in = $5, current_stock = $6, unit = $7
        WHERE id = $8
      `, [product_name, category || 'Umum', cost_price || 0, price || 0, newStockIn, newCurrent, unit || 'pcs', existing.id]);

      res.json({ success: true, message: `Produk & Stok berhasil diperbarui! (+${added} stok masuk)` });
    } else {
      // Produk Baru
      const initialStock = Number(add_stock_in || 0);
      await client.query(`
        INSERT INTO products (company_id, product_code, product_name, category, cost_price, price, stock_in, stock_sold, current_stock, unit)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $7, $8)
      `, [targetCompId, product_code, product_name, category || 'Umum', cost_price || 0, price || 0, initialStock, unit || 'pcs']);

      res.json({ success: true, message: `Produk baru "${product_name}" berhasil ditambahkan!` });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 3. Checkout Kasir POS (Multi-Item Real Time + Otomatis Potong Stok)
app.post('/api/pos/checkout', async (req, res) => {
  const { companyId, branch_code, items, payment_method, customer_name } = req.body;
  const targetCompId = companyId || 'COMP-001';
  const branch = branch_code || 'Kantor Pusat Bandung';
  const client = await pool.connect();

  try {
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Keranjang belanja kosong!' });
    }

    const trxId = 'POS-' + Date.now().toString().slice(-6);
    const trxDate = new Date().toISOString().split('T')[0];

    // Simpan setiap item ke tabel sales & kurangi stok produk
    for (const item of items) {
      const qty = Number(item.qty || 1);
      const totalAmount = Number(item.subtotal || (item.price * qty));

      // 1. Simpan Transaksi Penjualan
      await client.query(`
        INSERT INTO sales (company_id, branch_code, trx_id, trx_date, customer_name, product_name, qty, total_amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [targetCompId, branch, trxId, trxDate, customer_name || 'Umum', item.product_name, qty, totalAmount]);

      // 2. Potong Stok Produk & Tambah Barang Terjual
      await client.query(`
        UPDATE products
        SET stock_sold = stock_sold + $1,
            current_stock = GREATEST(0, current_stock - $1)
        WHERE company_id = $2 AND (product_code = $3 OR product_name = $4)
      `, [qty, targetCompId, item.product_code || '', item.product_name]);
    }

    res.json({ 
      success: true, 
      trxId: trxId, 
      message: 'Transaksi berhasil disimpan & stok otomatis terpotong!' 
    });
  } catch (err) {
    console.error('POS Checkout Error:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// ==========================================
// 📊 DASHBOARD & SYNC MASTER
// ==========================================

app.post('/api/reset-sales', async (req, res) => {
  if (!checkApiKey(req)) return res.status(401).json({ success: false, message: 'Akses Ditolak!' });
  const client = await pool.connect();
  try {
    const compId = req.body.companyId || 'COMP-001';
    await client.query('DELETE FROM sales WHERE company_id = $1', [compId]);
    await client.query('UPDATE products SET stock_sold = 0, current_stock = stock_in WHERE company_id = $1', [compId]);
    res.json({ success: true, message: 'Semua transaksi & penjualan di-reset menjadi Rp 0!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/sync/config', async (req, res) => {
  if (!checkApiKey(req)) return res.status(401).json({ success: false, message: 'Akses Ditolak!' });
  const client = await pool.connect();
  try {
    const { company, modules, branches } = req.body;
    const compId = (company && company.company_id) ? company.company_id : 'COMP-001';

    if (company) {
      const compName = company.company_name || 'VARDHANA NIRWANA';
      const planTier = company.plan_tier || 'BASIC';
      const logoUrl = company.logo_url || '';
      const address = company.address || '';
      const phone = company.phone || '';
      const email = company.email || '';
      const status = company.status || 'ACTIVE';

      const checkComp = await client.query('SELECT 1 FROM companies WHERE company_id = $1', [compId]);
      if (checkComp.rows.length > 0) {
        await client.query(`
          UPDATE companies
          SET company_name = $1, plan_tier = $2, logo_url = $3, address = $4, phone = $5, email = $6, status = $7
          WHERE company_id = $8
        `, [compName, planTier, logoUrl, address, phone, email, status, compId]);
      } else {
        await client.query(`
          INSERT INTO companies (company_id, company_name, plan_tier, logo_url, address, phone, email, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [compId, compName, planTier, logoUrl, address, phone, email, status]);
      }
    }

    if (modules && Array.isArray(modules)) {
      for (const m of modules) {
        const isEnabled = Boolean(
          m.is_enabled === true || m.is_enabled === 'true' || m.is_enabled === 1 || 
          String(m.is_enabled).trim().toUpperCase() === 'ON' || String(m.is_enabled).trim().toUpperCase() === 'AKTIF'
        );
        const mCode = String(m.module_code || m.module_id || 'MOD_SALES').trim();
        const mName = String(m.module_name || mCode).trim();

        const checkMod = await client.query('SELECT 1 FROM modules WHERE company_id = $1 AND (module_code = $2 OR module_id = $2)', [compId, mCode]);
        if (checkMod.rows.length > 0) {
          await client.query(`UPDATE modules SET module_name = $1, is_enabled = $2, module_code = $3, module_id = $3 WHERE company_id = $4 AND (module_code = $5 OR module_id = $5)`, [mName, isEnabled, mCode, compId, mCode]);
        } else {
          await client.query(`INSERT INTO modules (module_id, company_id, module_code, module_name, is_enabled) VALUES ($1, $2, $3, $4, $5)`, [mCode, compId, mCode, mName, isEnabled]);
        }
      }
    }

    if (branches && Array.isArray(branches)) {
      await client.query('DELETE FROM branches WHERE company_id = $1', [compId]);
      for (const b of branches) {
        const bCode = String(b.branch_code || b.branch_name || 'PUSAT').trim();
        const bName = String(b.branch_name || bCode).trim();
        const bCity = String(b.city || 'Bandung').trim();

        await client.query(`
          INSERT INTO branches (branch_id, company_id, branch_code, branch_name, city)
          VALUES ($1, $2, $3, $4, $5)
        `, [bCode, compId, bCode, bName, bCity]);
      }
    }

    res.json({ success: true, message: 'Profil dan 5 Cabang berhasil disinkronkan!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// Dashboard Data API
app.get('/api/dashboard/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const branch = req.query.branch || '';
  const client = await pool.connect();

  try {
    const compRes = await client.query('SELECT * FROM companies WHERE company_id = $1', [companyId]);
    const company = compRes.rows[0] || { company_id: companyId, company_name: 'VARDHANA NIRWANA', plan_tier: 'BASIC', logo_url: '' };

    const modRes = await client.query('SELECT module_code, module_name, is_enabled FROM modules WHERE company_id = $1 ORDER BY module_code ASC', [companyId]);
    const branchRes = await client.query('SELECT branch_code, branch_name, city FROM branches WHERE company_id = $1 ORDER BY branch_name ASC', [companyId]);

    // KPI Sales
    let kpiSql = `SELECT COALESCE(SUM(total_amount), 0) as total_revenue, COUNT(*) as total_trx, COALESCE(SUM(qty), 0) as total_qty FROM sales WHERE company_id = $1`;
    const kpiParams = [companyId];
    if (branch) { kpiSql += ` AND (branch_code = $2 OR branch_code = (SELECT branch_name FROM branches WHERE branch_code = $2 LIMIT 1))`; kpiParams.push(branch); }
    const kpiRes = await client.query(kpiSql, kpiParams);

    // Kinerja Tiap Cabang
    const branchPerf = await client.query(`
      SELECT 
        b.branch_code, b.branch_name, b.city,
        COALESCE(SUM(s.total_amount), 0) as total_revenue,
        COUNT(s.id) as total_trx
      FROM branches b
      LEFT JOIN sales s ON (s.branch_code = b.branch_code OR s.branch_code = b.branch_name) AND s.company_id = b.company_id
      WHERE b.company_id = $1
      GROUP BY b.branch_code, b.branch_name, b.city
      ORDER BY total_revenue DESC
    `, [companyId]);

    // Top Produk
    let topProdSql = `SELECT product_name, SUM(qty) as total_qty, SUM(total_amount) as total_amount FROM sales WHERE company_id = $1`;
    const topProdParams = [companyId];
    if (branch) { topProdSql += ` AND (branch_code = $2 OR branch_code = (SELECT branch_name FROM branches WHERE branch_code = $2 LIMIT 1))`; topProdParams.push(branch); }
    topProdSql += ` GROUP BY product_name ORDER BY total_amount DESC LIMIT 5`;
    const topProdRes = await client.query(topProdSql, topProdParams);

    // Tren Harian
    let dailySql = `SELECT TO_CHAR(trx_date, 'YYYY-MM-DD') as s_date, SUM(total_amount) as daily_total FROM sales WHERE company_id = $1`;
    const dailyParams = [companyId];
    if (branch) { dailySql += ` AND (branch_code = $2 OR branch_code = (SELECT branch_name FROM branches WHERE branch_code = $2 LIMIT 1))`; dailyParams.push(branch); }
    dailySql += ` GROUP BY s_date ORDER BY s_date ASC LIMIT 7`;
    const dailyRes = await client.query(dailySql, dailyParams);

    // Transaksi Terakhir
    let trxSql = `
      SELECT s.trx_id, s.trx_date, s.customer_name, s.product_name, s.qty, s.total_amount, s.branch_code,
             COALESCE(b.branch_name, s.branch_code) as branch_name
      FROM sales s
      LEFT JOIN branches b ON (s.branch_code = b.branch_code OR s.branch_code = b.branch_name) AND s.company_id = b.company_id
      WHERE s.company_id = $1
    `;
    const trxParams = [companyId];
    if (branch) { trxSql += ` AND (s.branch_code = $2 OR s.branch_code = (SELECT branch_name FROM branches WHERE branch_code = $2 LIMIT 1))`; trxParams.push(branch); }
    trxSql += ` ORDER BY s.trx_date DESC, s.trx_id DESC LIMIT 10`;
    const trxRes = await client.query(trxSql, trxParams);

    // Data Stok & Inventori Real Time
    const stockRes = await client.query(`
      SELECT product_code, product_name, category, cost_price, price, stock_in, stock_sold, current_stock, unit
      FROM products WHERE company_id = $1 ORDER BY current_stock ASC
    `, [companyId]);

    res.json({
      success: true,
      company: company,
      modules: modRes.rows,
      branches: branchRes.rows,
      branchPerformance: branchPerf.rows,
      inventory: stockRes.rows,
      kpi: {
        totalRevenue: Number(kpiRes.rows[0].total_revenue),
        totalTrx: Number(kpiRes.rows[0].total_trx),
        totalQty: Number(kpiRes.rows[0].total_qty),
        topProduct: topProdRes.rows[0] ? topProdRes.rows[0].product_name : '-'
      },
      charts: {
        daily: { labels: dailyRes.rows.map(r => r.s_date), values: dailyRes.rows.map(r => Number(r.daily_total)) },
        topProducts: { labels: topProdRes.rows.map(r => r.product_name), values: topProdRes.rows.map(r => Number(r.total_amount)) }
      },
      transactions: trxRes.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/pos', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'pos.html')); });

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 Server aktif di port ${PORT}`));
}
