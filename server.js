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

// Auto-Migration Kolom Profil
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS email VARCHAR(100);
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS status VARCHAR(50);

      DELETE FROM sales WHERE company_id = 'COMP-002';
      DELETE FROM modules WHERE company_id = 'COMP-002';
      DELETE FROM branches WHERE company_id = 'COMP-002';
      DELETE FROM companies WHERE company_id = 'COMP-002';
    `);
    console.log('✅ DB Siap: COMP-002 dibersihkan & profil aktif.');
  } catch (err) {
    console.warn('DB Init Log:', err.message);
  } finally {
    client.release();
  }
}
initDb();

// Cek Kunci API Keamanan Fleksibel
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

// 1. Health Endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', server: 'Vercel Serverless', timestamp: new Date() });
});

// 2. Sync Master Config (SELECT 1 Universal - Anti Error Kolom ID)
app.post('/api/sync/config', async (req, res) => {
  if (!checkApiKey(req)) {
    return res.status(401).json({ success: false, message: 'Akses Ditolak! API Key tidak valid.' });
  }

  const client = await pool.connect();
  try {
    const { company, modules, branches } = req.body;

    // A. Simpan Profil Perusahaan
    if (company) {
      const compId = company.company_id || 'COMP-001';
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

    // B. Simpan Modul ON / OFF
    if (modules && Array.isArray(modules)) {
      for (const m of modules) {
        const isEnabled = Boolean(
          m.is_enabled === true || 
          m.is_enabled === 'true' || 
          m.is_enabled === 1 || 
          String(m.is_enabled).trim().toUpperCase() === 'ON' ||
          String(m.is_enabled).trim().toUpperCase() === 'AKTIF'
        );

        const checkMod = await client.query('SELECT 1 FROM modules WHERE company_id = $1 AND module_code = $2', [m.company_id, m.module_code]);
        if (checkMod.rows.length > 0) {
          await client.query(`
            UPDATE modules
            SET module_name = $1, is_enabled = $2
            WHERE company_id = $3 AND module_code = $4
          `, [m.module_name, isEnabled, m.company_id, m.module_code]);
        } else {
          await client.query(`
            INSERT INTO modules (company_id, module_code, module_name, is_enabled)
            VALUES ($1, $2, $3, $4)
          `, [m.company_id, m.module_code, m.module_name, isEnabled]);
        }
      }
    }

    // C. Simpan Cabang (Multi-Cabang)
    if (branches && Array.isArray(branches)) {
      for (const b of branches) {
        const checkBr = await client.query('SELECT 1 FROM branches WHERE company_id = $1 AND branch_code = $2', [b.company_id, b.branch_code]);
        if (checkBr.rows.length > 0) {
          await client.query(`
            UPDATE branches
            SET branch_name = $1, city = $2
            WHERE company_id = $3 AND branch_code = $4
          `, [b.branch_name, b.city, b.company_id, b.branch_code]);
        } else {
          await client.query(`
            INSERT INTO branches (company_id, branch_code, branch_name, city)
            VALUES ($1, $2, $3, $4)
          `, [b.company_id, b.branch_code, b.branch_name, b.city]);
        }
      }
    }

    res.json({ success: true, message: 'Master profil, logo, modul & cabang berhasil disimpan!' });
  } catch (err) {
    console.error('Sync Error:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 3. Sync Transactions
app.post('/api/sync/import', async (req, res) => {
  if (!checkApiKey(req)) {
    return res.status(401).json({ success: false, message: 'Akses Ditolak! API Key tidak valid.' });
  }

  const client = await pool.connect();
  try {
    const { companyId, transactions } = req.body;
    const targetCompId = companyId || 'COMP-001';

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.json({ success: true, message: 'Data kosong.' });
    }

    for (const t of transactions) {
      const checkSale = await client.query('SELECT 1 FROM sales WHERE company_id = $1 AND trx_id = $2', [targetCompId, t.trx_id]);
      if (checkSale.rows.length > 0) {
        await client.query(`
          UPDATE sales
          SET total_amount = $1, qty = $2, branch_code = $3, trx_date = $4, customer_name = $5, product_name = $6
          WHERE company_id = $7 AND trx_id = $8
        `, [t.total_amount || 0, t.qty || 1, t.branch_code || 'BR-01', t.trx_date, t.customer_name, t.product_name, targetCompId, t.trx_id]);
      } else {
        await client.query(`
          INSERT INTO sales (company_id, branch_code, trx_id, trx_date, customer_name, product_name, qty, total_amount)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
    }

    res.json({ success: true, message: `${transactions.length} transaksi cabang tersinkron!` });
  } catch (err) {
    console.error('Import Error:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 4. Dashboard Data API
app.get('/api/dashboard/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const branch = req.query.branch || '';
  const client = await pool.connect();

  try {
    const compRes = await client.query('SELECT * FROM companies WHERE company_id = $1', [companyId]);
    const company = compRes.rows[0] || { 
      company_id: companyId, 
      company_name: 'VARDHANA NIRWANA', 
      plan_tier: 'BASIC',
      logo_url: '' 
    };

    const modRes = await client.query('SELECT module_code, module_name, is_enabled FROM modules WHERE company_id = $1 ORDER BY module_code ASC', [companyId]);
    const branchRes = await client.query('SELECT branch_code, branch_name, city FROM branches WHERE company_id = $1 ORDER BY branch_code ASC', [companyId]);

    // KPI Sales Universal COUNT(*)
    let kpiSql = `SELECT COALESCE(SUM(total_amount), 0) as total_revenue, COUNT(*) as total_trx, COALESCE(SUM(qty), 0) as total_qty FROM sales WHERE company_id = $1`;
    const kpiParams = [companyId];
    if (branch) { kpiSql += ` AND branch_code = $2`; kpiParams.push(branch); }
    const kpiRes = await client.query(kpiSql, kpiParams);

    // Kinerja Tiap Cabang
    const branchPerf = await client.query(`
      SELECT s.branch_code, COALESCE(b.branch_name, s.branch_code) as branch_name, COALESCE(b.city, '-') as city,
             COALESCE(SUM(s.total_amount), 0) as total_revenue, COUNT(*) as total_trx
      FROM sales s
      LEFT JOIN branches b ON s.branch_code = b.branch_code AND s.company_id = b.company_id
      WHERE s.company_id = $1
      GROUP BY s.branch_code, b.branch_name, b.city
      ORDER BY total_revenue DESC
    `, [companyId]);

    // Top Produk
    let topProdSql = `SELECT product_name, SUM(qty) as total_qty, SUM(total_amount) as total_amount FROM sales WHERE company_id = $1`;
    const topProdParams = [companyId];
    if (branch) { topProdSql += ` AND branch_code = $2`; topProdParams.push(branch); }
    topProdSql += ` GROUP BY product_name ORDER BY total_amount DESC LIMIT 5`;
    const topProdRes = await client.query(topProdSql, topProdParams);

    // Tren Harian
    let dailySql = `SELECT TO_CHAR(trx_date, 'YYYY-MM-DD') as s_date, SUM(total_amount) as daily_total FROM sales WHERE company_id = $1`;
    const dailyParams = [companyId];
    if (branch) { dailySql += ` AND branch_code = $2`; dailyParams.push(branch); }
    dailySql += ` GROUP BY s_date ORDER BY s_date ASC LIMIT 7`;
    const dailyRes = await client.query(dailySql, dailyParams);

    // Transaksi Terakhir
    let trxSql = `
      SELECT s.trx_id, s.trx_date, s.customer_name, s.product_name, s.qty, s.total_amount, s.branch_code,
             COALESCE(b.branch_name, s.branch_code) as branch_name
      FROM sales s
      LEFT JOIN branches b ON s.branch_code = b.branch_code AND s.company_id = b.company_id
      WHERE s.company_id = $1
    `;
    const trxParams = [companyId];
    if (branch) { trxSql += ` AND s.branch_code = $2`; trxParams.push(branch); }
    trxSql += ` ORDER BY s.trx_date DESC, s.trx_id DESC LIMIT 10`;
    const trxRes = await client.query(trxSql, trxParams);

    res.json({
      success: true,
      company: company,
      modules: modRes.rows,
      branches: branchRes.rows,
      branchPerformance: branchPerf.rows,
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
          labels: topProdRes.rows.map(r => r.product_name),
          values: topProdRes.rows.map(r => Number(r.total_amount))
        }
      },
      transactions: trxRes.rows
    });
  } catch (err) {
    console.error('Dashboard Error:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 Server aktif di port ${PORT}`));
}
