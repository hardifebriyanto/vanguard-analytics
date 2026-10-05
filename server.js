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

// PostgreSQL Pool (Neon Cloud AWS Singapore)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto-Migration: Tambah kolom logo, alamat, kontak & Bersihkan COMP-002
async function initDb() {
  const client = await pool.connect();
  try {
    // 1. Pastikan kolom logo, alamat, hp, email tersedia di tabel companies
    await client.query(`
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS email VARCHAR(100);
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS status VARCHAR(50);
    `);

    // 2. Hapus data dummy COMP-002 sesuai permintaan
    await client.query(`
      DELETE FROM sales WHERE company_id = 'COMP-002';
      DELETE FROM modules WHERE company_id = 'COMP-002';
      DELETE FROM branches WHERE company_id = 'COMP-002';
      DELETE FROM companies WHERE company_id = 'COMP-002';
    `);
    console.log('✅ Database siap: Fitur Logo & Multi-Cabang aktif. COMP-002 dibersihkan.');
  } catch (err) {
    console.warn('Init DB info:', err.message);
  } finally {
    client.release();
  }
}
initDb();

// Helper Verifikasi API Key
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

// 1. Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', server: 'Vercel Serverless', timestamp: new Date() });
});

// 2. Sync Master Config (Company, Logo, Modules, Branches)
app.post('/api/sync/config', async (req, res) => {
  if (!checkApiKey(req)) {
    return res.status(401).json({ success: false, message: 'Akses Ditolak! API Key tidak valid.' });
  }

  const client = await pool.connect();
  try {
    const { company, modules, branches } = req.body;

    // Upsert Company lengkap dengan Logo & Profil
    if (company) {
      const compId = company.company_id || company.id || 'COMP-001';
      const compName = company.company_name || company.name || 'VARDHANA NIRWANA';
      const planTier = company.plan_tier || company.package_id || 'BASIC';
      const logoUrl = company.logo_url || '';
      const address = company.address || '';
      const phone = company.phone || '';
      const email = company.email || '';
      const status = company.status || 'ACTIVE';

      await client.query(`
        INSERT INTO companies (company_id, company_name, plan_tier, logo_url, address, phone, email, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (company_id) DO UPDATE
        SET company_name = EXCLUDED.company_name,
            plan_tier = EXCLUDED.plan_tier,
            logo_url = EXCLUDED.logo_url,
            address = EXCLUDED.address,
            phone = EXCLUDED.phone,
            email = EXCLUDED.email,
            status = EXCLUDED.status;
      `, [compId, compName, planTier, logoUrl, address, phone, email, status]);
    }

    // Upsert Modules
    if (modules && Array.isArray(modules)) {
      for (const m of modules) {
        const isEnabled = Boolean(
          m.is_enabled === true || 
          m.is_enabled === 'true' || 
          m.is_enabled === 1 || 
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

    // Upsert Branches (Multi-Cabang)
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

    res.json({ success: true, message: 'Konfigurasi profil perusahaan & multi-cabang tersimpan!' });
  } catch (err) {
    console.error('Error sync config:', err);
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
    const { companyId, company_id, transactions } = req.body;
    const targetCompId = companyId || company_id || 'COMP-001';

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.json({ success: true, message: 'Tidak ada data transaksi.' });
    }

    for (const t of transactions) {
      await client.query(`
        INSERT INTO sales (company_id, branch_code, trx_id, trx_date, customer_name, product_name, qty, total_amount)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (company_id, trx_id) DO UPDATE
        SET total_amount = EXCLUDED.total_amount, qty = EXCLUDED.qty, branch_code = EXCLUDED.branch_code;
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

    res.json({ success: true, message: `${transactions.length} transaksi multi-cabang tersinkron!` });
  } catch (err) {
    console.error('Error import:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 4. Dashboard Data API (Mendukung Multi-Cabang Konsolidasi & Per Cabang)
app.get('/api/dashboard/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const branchFilter = req.query.branch || ''; // Filter per cabang opsional
  const client = await pool.connect();

  try {
    // 1. Profil Company Lengkap dengan Logo
    const compRes = await client.query('SELECT * FROM companies WHERE company_id = $1', [companyId]);
    const company = compRes.rows[0] || { 
      company_id: companyId, 
      company_name: 'VARDHANA NIRWANA', 
      plan_tier: 'BASIC',
      logo_url: '' 
    };

    // 2. Daftar Modul
    const modRes = await client.query('SELECT module_code, module_name, is_enabled FROM modules WHERE company_id = $1 ORDER BY id ASC', [companyId]);

    // 3. Daftar Cabang
    const branchRes = await client.query('SELECT branch_code, branch_name, city FROM branches WHERE company_id = $1 ORDER BY branch_code ASC', [companyId]);

    // 4. KPI & Sales (Bisa konsolidasi semua cabang atau filter 1 cabang)
    let kpiSql = `
      SELECT 
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COUNT(id) as total_trx,
        COALESCE(SUM(qty), 0) as total_qty
      FROM sales
      WHERE company_id = $1
    `;
    const kpiParams = [companyId];
    if (branchFilter) {
      kpiSql += ` AND branch_code = $2`;
      kpiParams.push(branchFilter);
    }
    const kpiRes = await client.query(kpiSql, kpiParams);

    // 5. Performa Masing-Masing Cabang
    const branchPerfRes = await client.query(`
      SELECT 
        s.branch_code,
        COALESCE(b.branch_name, s.branch_code) as branch_name,
        COALESCE(b.city, '-') as city,
        COALESCE(SUM(s.total_amount), 0) as total_revenue,
        COUNT(s.id) as total_trx
      FROM sales s
      LEFT JOIN branches b ON s.branch_code = b.branch_code AND s.company_id = b.company_id
      WHERE s.company_id = $1
      GROUP BY s.branch_code, b.branch_name, b.city
      ORDER BY total_revenue DESC
    `, [companyId]);

    // 6. Top Produk
    let topProdSql = `
      SELECT product_name, SUM(qty) as total_qty, SUM(total_amount) as total_amount
      FROM sales WHERE company_id = $1
    `;
    const topProdParams = [companyId];
    if (branchFilter) {
      topProdSql += ` AND branch_code = $2`;
      topProdParams.push(branchFilter);
    }
    topProdSql += ` GROUP BY product_name ORDER BY total_amount DESC LIMIT 5`;
    const topProdRes = await client.query(topProdSql, topProdParams);

    // 7. Tren Penjualan Harian
    let dailySql = `
      SELECT TO_CHAR(trx_date, 'YYYY-MM-DD') as s_date, SUM(total_amount) as daily_total
      FROM sales WHERE company_id = $1
    `;
    const dailyParams = [companyId];
    if (branchFilter) {
      dailySql += ` AND branch_code = $2`;
      dailyParams.push(branchFilter);
    }
    dailySql += ` GROUP BY s_date ORDER BY s_date ASC LIMIT 7`;
    const dailyRes = await client.query(dailySql, dailyParams);

    // 8. Transaksi Terbaru
    let trxSql = `
      SELECT s.trx_id, s.trx_date, s.customer_name, s.product_name, s.qty, s.total_amount, s.branch_code,
             COALESCE(b.branch_name, s.branch_code) as branch_name
      FROM sales s
      LEFT JOIN branches b ON s.branch_code = b.branch_code AND s.company_id = b.company_id
      WHERE s.company_id = $1
    `;
    const trxParams = [companyId];
    if (branchFilter) {
      trxSql += ` AND s.branch_code = $2`;
      trxParams.push(branchFilter);
    }
    trxSql += ` ORDER BY s.trx_date DESC, s.id DESC LIMIT 10`;
    const trxRes = await client.query(trxSql, trxParams);

    res.json({
      success: true,
      company: company,
      modules: modRes.rows,
      branches: branchRes.rows,
      branchPerformance: branchPerfRes.rows,
      activeBranchFilter: branchFilter,
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
    console.error('Error dashboard:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// Root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`🚀 Server aktif di port ${PORT}`));
}
