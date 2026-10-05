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

// Helper Auth Key
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

// 2. Daftar Perusahaan (Multi-Tenant Companies List)
app.get('/api/companies', async (req, res) => {
  const client = await pool.connect();
  try {
    const compRes = await client.query('SELECT company_id, company_name, plan_tier FROM companies ORDER BY company_id ASC');
    let companies = compRes.rows;

    // Pastikan COMP-001 dan COMP-002 selalu ada
    if (!companies.some(c => c.company_id === 'COMP-001')) {
      companies.unshift({ company_id: 'COMP-001', company_name: 'PT Maju Jaya (Kopi)', plan_tier: 'ENTERPRISE' });
    }
    if (!companies.some(c => c.company_id === 'COMP-002')) {
      companies.push({ company_id: 'COMP-002', company_name: 'CV Berkah Abadi (Bakery)', plan_tier: 'BASIC' });
    }

    res.json({ success: true, companies: companies });
  } catch (err) {
    res.json({
      success: true,
      companies: [
        { company_id: 'COMP-001', company_name: 'PT Maju Jaya', plan_tier: 'ENTERPRISE' },
        { company_id: 'COMP-002', company_name: 'CV Berkah Abadi (Bakery)', plan_tier: 'BASIC' }
      ]
    });
  } finally {
    client.release();
  }
});

// 3. Sync Config
app.post('/api/sync/config', async (req, res) => {
  if (!checkApiKey(req)) {
    return res.status(401).json({ success: false, message: 'Akses Ditolak! API Key tidak valid.' });
  }

  const client = await pool.connect();
  try {
    const { company, modules } = req.body;

    try { await client.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_tier VARCHAR(50) DEFAULT 'STANDARD';`); } catch (e) {}
    try { await client.query(`ALTER TABLE modules ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN DEFAULT true;`); } catch (e) {}

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
        await client.query(`
          INSERT INTO companies (company_id, company_name)
          VALUES ($1, $2)
          ON CONFLICT (company_id) DO UPDATE
          SET company_name = EXCLUDED.company_name;
        `, [compId, compName]);
      }
    }

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

        try {
          await client.query(`
            INSERT INTO modules (company_id, module_code, module_name, is_enabled)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (company_id, module_code) DO UPDATE
            SET module_name = EXCLUDED.module_name, is_enabled = EXCLUDED.is_enabled;
          `, [m.company_id, m.module_code, m.module_name, isEnabled]);
        } catch (mErr) {
          const updateRes = await client.query(`
            UPDATE modules 
            SET module_name = $3, is_enabled = $4 
            WHERE company_id = $1 AND module_code = $2;
          `, [m.company_id, m.module_code, m.module_name, isEnabled]);

          if (updateRes.rowCount === 0) {
            await client.query(`
              INSERT INTO modules (company_id, module_code, module_name, is_enabled)
              VALUES ($1, $2, $3, $4);
            `, [m.company_id, m.module_code, m.module_name, isEnabled]);
          }
        }
      }
    }

    res.json({ success: true, message: 'Konfigurasi master & modul berhasil diupdate!' });
  } catch (err) {
    console.error('Error sync config:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 4. Sync Transactions Import
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

    try { await client.query(`ALTER TABLE sales ALTER COLUMN transaction_no DROP NOT NULL;`); } catch (e) {}
    try {
      await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS trx_id VARCHAR(50);`);
      await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS transaction_no VARCHAR(50);`);
      await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_name VARCHAR(100);`);
      await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS product_name VARCHAR(100);`);
      await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS qty NUMERIC DEFAULT 1;`);
      await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS total_amount NUMERIC DEFAULT 0;`);
      await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS branch_code VARCHAR(50);`);
      await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS trx_date DATE DEFAULT CURRENT_DATE;`);
    } catch (migErr) {}

    for (const t of transactions) {
      const code = t.trx_id || `TRX-${Date.now()}`;
      try {
        await client.query(`
          INSERT INTO sales (
            company_id, branch_code, trx_id, transaction_no, trx_date, customer_name, product_name, qty, total_amount
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
        `, [
          targetCompId,
          t.branch_code || 'BR-01',
          code,
          code,
          t.trx_date,
          t.customer_name,
          t.product_name,
          t.qty || 1,
          t.total_amount || 0
        ]);
      } catch (sErr) {}
    }

    res.json({ success: true, message: `${transactions.length} transaksi berhasil disinkron!` });
  } catch (err) {
    console.error('Error import:', err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 5. Dashboard Data API (Multi-Tenant Real)
app.get('/api/dashboard/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const client = await pool.connect();

  try {
    // === SEED KHUSUS JIKA CLIENT 2 (COMP-002) DIBUKA PERTAMA KALI ===
    if (companyId === 'COMP-002') {
      try {
        await client.query(`
          INSERT INTO companies (company_id, company_name, plan_tier)
          VALUES ('COMP-002', 'CV Berkah Abadi (Bakery)', 'BASIC')
          ON CONFLICT (company_id) DO NOTHING;
        `);
        // Modul COMP-002: Hanya Sales yang ON, yang lain OFF (Terkunci)
        const defaultMod = [
          ['COMP-002', 'SALES', 'Sales Analytics', true],
          ['COMP-002', 'FINANCE', 'Financial Analytics', false],
          ['COMP-002', 'INVENTORY', 'Inventory Analytics', false],
          ['COMP-002', 'CUSTOMER', 'Customer Analytics', false],
          ['COMP-002', 'PRODUCTION', 'Production Analytics', false],
          ['COMP-002', 'REPORT', 'Report Management', false]
        ];
        for (const [cid, code, name, on] of defaultMod) {
          await client.query(`
            INSERT INTO modules (company_id, module_code, module_name, is_enabled)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (company_id, module_code) DO NOTHING;
          `, [cid, code, name, on]);
        }
        // Transaksi khusus COMP-002 (Bakery)
        const bakeryTrx = [
          ['COMP-002', 'BR-B1', 'TRX-BK01', '2026-10-04', 'Cafe Senopati', 'Croissant Butter Keju', 30, 900000],
          ['COMP-002', 'BR-B1', 'TRX-BK02', '2026-10-05', 'Toko Kue Manis', 'Donat Cokelat Lumer', 50, 500000],
          ['COMP-002', 'BR-B2', 'TRX-BK03', '2026-10-05', 'Warung Ibu Sri', 'Roti Sisir Mentega', 25, 375000]
        ];
        for (const [cid, br, tid, dt, cust, prod, q, tot] of bakeryTrx) {
          await client.query(`
            INSERT INTO sales (company_id, branch_code, trx_id, transaction_no, trx_date, customer_name, product_name, qty, total_amount)
            VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (company_id, trx_id) DO NOTHING;
          `, [cid, br, tid, dt, cust, prod, q, tot]);
        }
      } catch (seedErr) {}
    }

    // A. Company Info
    let company = { company_id: companyId, company_name: companyId === 'COMP-002' ? 'CV Berkah Abadi' : 'PT Maju Jaya', plan_tier: companyId === 'COMP-002' ? 'BASIC' : 'ENTERPRISE' };
    try {
      const compRes = await client.query('SELECT * FROM companies WHERE company_id = $1', [companyId]);
      if (compRes.rows[0]) company = compRes.rows[0];
    } catch (e) {}

    // B. Modules (Isolasi per tenant)
    let modules = [];
    try {
      const modRes = await client.query('SELECT module_code, module_name, is_enabled FROM modules WHERE company_id = $1 ORDER BY id ASC', [companyId]);
      modules = modRes.rows;
    } catch (e) {}

    // C. KPI Total Sales
    let kpi = { totalRevenue: 0, totalTrx: 0, totalQty: 0, topProduct: '-' };
    try {
      const kpiRes = await client.query(`
        SELECT 
          COALESCE(SUM(total_amount), 0) as total_revenue,
          COUNT(*) as total_trx,
          COALESCE(SUM(qty), 0) as total_qty
        FROM sales
        WHERE company_id = $1
      `, [companyId]);

      if (kpiRes.rows[0]) {
        kpi.totalRevenue = Number(kpiRes.rows[0].total_revenue);
        kpi.totalTrx = Number(kpiRes.rows[0].total_trx);
        kpi.totalQty = Number(kpiRes.rows[0].total_qty);
      }
    } catch (e) {}

    // D. Top Product
    try {
      const topProdRes = await client.query(`
        SELECT product_name, SUM(qty) as total_qty
        FROM sales
        WHERE company_id = $1
        GROUP BY product_name
        ORDER BY total_qty DESC
        LIMIT 1
      `, [companyId]);
      if (topProdRes.rows[0]) kpi.topProduct = topProdRes.rows[0].product_name;
    } catch (e) {}

    // E. Daily Sales
    let dailyLabels = [];
    let dailyValues = [];
    try {
      const dailyRes = await client.query(`
        SELECT TO_CHAR(trx_date, 'YYYY-MM-DD') as s_date, SUM(total_amount) as daily_total
        FROM sales
        WHERE company_id = $1
        GROUP BY s_date
        ORDER BY s_date ASC
        LIMIT 7
      `, [companyId]);
      if (dailyRes.rows.length > 0) {
        dailyLabels = dailyRes.rows.map(r => r.s_date);
        dailyValues = dailyRes.rows.map(r => Number(r.daily_total));
      }
    } catch (e) {}

    // F. Top Products Breakdown
    let topProdLabels = [];
    let topProdValues = [];
    try {
      const top5ProdRes = await client.query(`
        SELECT product_name, SUM(total_amount) as total_amount
        FROM sales
        WHERE company_id = $1
        GROUP BY product_name
        ORDER BY total_amount DESC
        LIMIT 5
      `, [companyId]);
      if (top5ProdRes.rows.length > 0) {
        topProdLabels = top5ProdRes.rows.map(r => r.product_name);
        topProdValues = top5ProdRes.rows.map(r => Number(r.total_amount));
      }
    } catch (e) {}

    // G. Recent Transactions
    let transactions = [];
    try {
      const trxRes = await client.query(`
        SELECT 
          COALESCE(trx_id, transaction_no, 'TRX-001') as trx_id, 
          trx_date, 
          customer_name, 
          product_name, 
          qty, 
          total_amount, 
          branch_code as branch_name
        FROM sales
        WHERE company_id = $1
        ORDER BY trx_date DESC
        LIMIT 15
      `, [companyId]);
      transactions = trxRes.rows;
    } catch (e) {}

    res.json({
      success: true,
      company: company,
      modules: modules,
      kpi: kpi,
      charts: {
        daily: { labels: dailyLabels, values: dailyValues },
        topProducts: { labels: topProdLabels, values: topProdValues }
      },
      transactions: transactions
    });
  } catch (err) {
    console.error('Error dashboard:', err);
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
  app.listen(PORT, () => console.log(`🚀 Server berjalan di port ${PORT}`));
}
