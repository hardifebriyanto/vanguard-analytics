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

// Auto-Migration Kolom Profil & Bersihkan Sampah Lama
async function initDb() {
  const client = await pool.connect();
  try {
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

      DELETE FROM sales WHERE company_id = 'COMP-002';
      DELETE FROM modules WHERE company_id = 'COMP-002';
      DELETE FROM branches WHERE company_id = 'COMP-002';
      DELETE FROM companies WHERE company_id = 'COMP-002';
    `);
    console.log('✅ DB Siap.');
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

// FITUR RESET SEMUA DATA PENJUALAN KE NOL
app.post('/api/reset-sales', async (req, res) => {
  if (!checkApiKey(req)) return res.status(401).json({ success: false, message: 'Akses Ditolak!' });
  const client = await pool.connect();
  try {
    const compId = req.body.companyId || 'COMP-001';
    await client.query('DELETE FROM sales WHERE company_id = $1', [compId]);
    res.json({ success: true, message: 'Semua transaksi berhasil di-reset menjadi Rp 0!' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 2. Sync Master Config (Daftar 5 Cabang Resmi)
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
          await client.query(`
            UPDATE modules SET module_name = $1, is_enabled = $2, module_code = $3, module_id = $3
            WHERE company_id = $4 AND (module_code = $5 OR module_id = $5)
          `, [mName, isEnabled, mCode, compId, mCode]);
        } else {
          await client.query(`
            INSERT INTO modules (module_id, company_id, module_code, module_name, is_enabled)
            VALUES ($1, $2, $3, $4, $5)
          `, [mCode, compId, mCode, mName, isEnabled]);
        }
      }
    }

    // Bersihkan cabang lama lalu masukkan 5 cabang resmi dari Sheets
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
    console.error('Sync Error:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 3. Sync Transactions (Murni dari Google Form)
app.post('/api/sync/import', async (req, res) => {
  if (!checkApiKey(req)) return res.status(401).json({ success: false, message: 'Akses Ditolak!' });
  const client = await pool.connect();
  try {
    const { companyId, transactions } = req.body;
    const targetCompId = companyId || 'COMP-001';

    // Bersihkan transaksi lama agar murni hanya isi Google Form saat ini
    await client.query('DELETE FROM sales WHERE company_id = $1', [targetCompId]);

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.json({ success: true, message: 'Data penjualan kosong (Rp 0).' });
    }

    for (const t of transactions) {
      await client.query(`
        INSERT INTO sales (company_id, branch_code, trx_id, trx_date, customer_name, product_name, qty, total_amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        targetCompId,
        t.branch_code || 'Kantor Pusat Bandung',
        t.trx_id,
        t.trx_date,
        t.customer_name || 'Umum',
        t.product_name || 'Produk',
        t.qty || 1,
        t.total_amount || 0
      ]);
    }

    res.json({ success: true, message: `${transactions.length} transaksi form tersinkron!` });
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
    const branchRes = await client.query('SELECT branch_code, branch_name, city FROM branches WHERE company_id = $1 ORDER BY branch_name ASC', [companyId]);

    // KPI Sales
    let kpiSql = `SELECT COALESCE(SUM(total_amount), 0) as total_revenue, COUNT(*) as total_trx, COALESCE(SUM(qty), 0) as total_qty FROM sales WHERE company_id = $1`;
    const kpiParams = [companyId];
    if (branch) { kpiSql += ` AND (branch_code = $2 OR branch_code = (SELECT branch_name FROM branches WHERE branch_code = $2 LIMIT 1))`; kpiParams.push(branch); }
    const kpiRes = await client.query(kpiSql, kpiParams);

    // Kinerja Tiap Cabang
    const branchPerf = await client.query(`
      SELECT 
        b.branch_code,
        b.branch_name,
        b.city,
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
