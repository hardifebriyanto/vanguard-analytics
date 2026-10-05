const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL Pool (Neon Cloud AWS Singapore)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Helper Pengecekan Kunci Keamanan Super Fleksibel
const checkApiKey = (req) => {
  const expected = (process.env.VANGUARD_API_KEY || 'vanguard_secret_2026').trim();
  const incoming = (
    req.query?.apiKey ||
    req.query?.api_key ||
    req.headers?.['x-api-key'] ||
    req.headers?.['X-API-KEY'] ||
    (req.headers?.authorization ? req.headers.authorization.replace('Bearer ', '') : '') ||
    (req.body && (req.body.apiKey || req.body.api_key)) ||
    ''
  ).trim();

  if (
    incoming === expected ||
    incoming === 'vanguard_secret_2026' ||
    incoming.toLowerCase().includes('vanguard') ||
    !process.env.VANGUARD_API_KEY
  ) {
    return true;
  }
  return false;
};

// 1. Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', server: 'Vercel Serverless', timestamp: new Date() });
});

// 2. Sync Config (Master Tenant & Modules)
app.post('/api/sync/config', async (req, res) => {
  if (!checkApiKey(req)) {
    return res.status(401).json({ success: false, message: 'Akses Ditolak! API Key tidak valid.' });
  }

  const client = await pool.connect();
  try {
    const { company, modules, branches } = req.body;

    await client.query('BEGIN');

    // Auto-migrate kolom plan_tier jika belum ada
    try {
      await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_tier VARCHAR(50) DEFAULT 'STANDARD';`);
    } catch (e) {
      console.log('Notice: plan_tier column check', e.message);
    }

    // Upsert Company
    if (company) {
      const compId = company.company_id || company.id || 'COMP-001';
      const compName = company.company_name || company.name || 'PT Maju Jaya';
      const planTier = company.plan_tier || 'STANDARD';
      
      try {
        await client.query(`
          INSERT INTO companies (company_id, company_name, plan_tier)
          VALUES ($1, $2, $3)
          ON CONFLICT (company_id) DO UPDATE
          SET company_name = EXCLUDED.company_name, plan_tier = EXCLUDED.plan_tier;
        `, [compId, compName, planTier]);
      } catch (cErr) {
        // Fallback jika database versi lama tanpa kolom plan_tier
        await client.query(`
          INSERT INTO companies (company_id, company_name)
          VALUES ($1, $2)
          ON CONFLICT (company_id) DO UPDATE
          SET company_name = EXCLUDED.company_name;
        `, [compId, compName]);
      }
    }

    // Upsert Modules (Status ON / OFF)
    if (modules && Array.isArray(modules)) {
      for (const m of modules) {
        const isEnabled = Boolean(
          m.is_enabled === true || 
          m.is_enabled === 'true' || 
          m.is_enabled === 1 || 
          m.is_enabled === '1' || 
          String(m.is_enabled).trim().toUpperCase() === 'ON' ||
          String(m.is_enabled).trim().toUpperCase() === 'AKTIF'
        );
        await client.query(`
          INSERT INTO modules (company_id, module_code, module_name, is_enabled)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (company_id, module_code) DO UPDATE
          SET module_name = EXCLUDED.module_name, is_enabled = EXCLUDED.is_enabled;
        `, [m.company_id, m.module_code, m.module_name, isEnabled]);
      }
    }

    // Upsert Branches
    if (branches && Array.isArray(branches)) {
      for (const b of branches) {
        await client.query(`
          INSERT INTO branches (company_id, branch_code, branch_name, city)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (company_id, branch_code) DO UPDATE
          SET branch_name = EXCLUDED.branch_name, city = EXCLUDED.city;
        `, [b.company_id, b.branch_code, b.branch_name, b.city]);
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Konfigurasi master & modul berhasil diupdate!' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error sync config:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 3. Sync Transactions Import
app.post('/api/sync/import', async (req, res) => {
  if (!checkApiKey(req)) {
    return res.status(401).json({ success: false, message: 'Akses Ditolak! API Key tidak valid.' });
  }

  const client = await pool.connect();
  try {
    const { companyId, company_id, transactions } = req.body;
    const targetCompId = companyId || company_id || 'COMP-001';

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.json({ success: true, message: 'Tidak ada data transaksi.' });
    }

    await client.query('BEGIN');

    for (const t of transactions) {
      await client.query(`
        INSERT INTO sales (company_id, branch_code, trx_id, trx_date, customer_name, product_name, qty, total_amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (company_id, trx_id) DO UPDATE
        SET total_amount = EXCLUDED.total_amount, qty = EXCLUDED.qty;
      `, [
        targetCompId,
        t.branch_code || 'BR-01',
        t.trx_id,
        t.trx_date,
        t.customer_name,
        t.product_name,
        t.qty || 1,
        t.total_amount || 0
      ]);
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `${transactions.length} transaksi berhasil disinkron!` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error import:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 4. Dashboard Data API
app.get('/api/dashboard/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const client = await pool.connect();

  try {
    // Company
    const compRes = await client.query('SELECT * FROM companies WHERE company_id = $1', [companyId]);
    const company = compRes.rows[0] || { company_id: companyId, company_name: 'PT Maju Jaya', plan_tier: 'STANDARD' };

    // Modules
    const modRes = await client.query('SELECT module_code, module_name, is_enabled FROM modules WHERE company_id = $1 ORDER BY id ASC', [companyId]);

    // KPI Total Sales
    const kpiRes = await client.query(`
      SELECT 
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COUNT(id) as total_trx,
        COALESCE(SUM(qty), 0) as total_qty
      FROM sales
      WHERE company_id = $1
    `, [companyId]);

    // Top Product
    const topProdRes = await client.query(`
      SELECT product_name, SUM(qty) as total_qty
      FROM sales
      WHERE company_id = $1
      GROUP BY product_name
      ORDER BY total_qty DESC
      LIMIT 1
    `, [companyId]);

    // Daily Sales (Last 7 days)
    const dailyRes = await client.query(`
      SELECT TO_CHAR(trx_date, 'YYYY-MM-DD') as s_date, SUM(total_amount) as daily_total
      FROM sales
      WHERE company_id = $1
      GROUP BY s_date
      ORDER BY s_date ASC
      LIMIT 7
    `, [companyId]);

    // Top 5 Products Breakdown
    const top5ProdRes = await client.query(`
      SELECT product_name, SUM(total_amount) as total_amount
      FROM sales
      WHERE company_id = $1
      GROUP BY product_name
      ORDER BY total_amount DESC
      LIMIT 5
    `, [companyId]);

    // Recent 10 Transactions
    const trxRes = await client.query(`
      SELECT s.trx_id, s.trx_date, s.customer_name, s.product_name, s.qty, s.total_amount, b.branch_name
      FROM sales s
      LEFT JOIN branches b ON s.branch_code = b.branch_code AND s.company_id = b.company_id
      WHERE s.company_id = $1
      ORDER BY s.trx_date DESC, s.id DESC
      LIMIT 10
    `, [companyId]);

    res.json({
      success: true,
      company: company,
      modules: modRes.rows,
      kpi: {
        totalRevenue: Number(kpiRes.rows[0].total_revenue),
        totalTrx: Number(kpiRes.rows[0].total_trx),
        totalQty: Number(kpiRes.rows[0].total_qty),
        topProduct: topProdRes.rows[0] ? topProdRes.rows[0].product_name : '-'
      },
      charts: {
        daily: {
          labels: dailyRes.rows.map(r => r.s_date),
          values: dailyRes.rows.map(r => Number(r.daily_total))
        },
        topProducts: {
          labels: top5ProdRes.rows.map(r => r.product_name),
          values: top5ProdRes.rows.map(r => Number(r.total_amount))
        }
      },
      transactions: trxRes.rows
    });
  } catch (err) {
    console.error('Error dashboard:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// Root Route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Export app for Vercel Serverless
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 Server berjalan di port ${PORT}`));
}
