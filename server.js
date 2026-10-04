require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = process.env.VANGUARD_API_KEY || 'vanguard_secret_2026';

// Koneksi ke Database PostgreSQL Neon
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Gagal terhubung ke PostgreSQL Neon:', err.message);
  } else {
    console.log('✅ BERHASIL TERHUBUNG KE POSTGRESQL NEON (CLOUD)!');
    release();
  }
});

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// Layani file statis Frontend dari folder public
app.use(express.static(path.join(__dirname, 'public')));

// 1. Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ONLINE', database: 'PostgreSQL Neon Connected', timestamp: new Date() });
});

// 2. ENDPOINT SYNC MASTER CONFIG
app.post('/api/sync/config', async (req, res) => {
  const clientKey = req.headers['x-vanguard-key'];
  if (clientKey !== SECRET_KEY) return res.status(401).json({ success: false, message: 'Akses Ditolak!' });

  const { company, users, modules } = req.body;
  if (!company || !company.CompanyID) return res.status(400).json({ success: false, message: 'Data invalid!' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO companies (company_id, company_name, logo_url, address, phone, email, package, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (company_id) DO UPDATE SET
        company_name = EXCLUDED.company_name,
        email = EXCLUDED.email,
        package = EXCLUDED.package,
        updated_at = NOW();
    `, [company.CompanyID, company.CompanyName, company.LogoURL || '', company.Address || '', company.Phone || '', company.Email || '', company.PackageID || 'STANDARD', company.Status || 'ACTIVE']);

    if (Array.isArray(modules)) {
      for (const m of modules) {
        if (!m.ModuleCode) continue;
        await client.query(`
          INSERT INTO modules (company_id, module_code, module_name, status)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (company_id, module_code) DO UPDATE SET
            module_name = EXCLUDED.module_name,
            status = EXCLUDED.status,
            updated_at = NOW();
        `, [company.CompanyID, m.ModuleCode, m.ModuleName || m.ModuleCode, m.Status || 'OFF']);
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: `Master data ${company.CompanyName} berhasil disimpan!` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 3. ENDPOINT IMPORT TRANSAKSI PENJUALAN
app.post('/api/sync/import', async (req, res) => {
  const clientKey = req.headers['x-vanguard-key'];
  if (clientKey !== SECRET_KEY) return res.status(401).json({ success: false, message: 'Akses Ditolak!' });

  const { company_id, transactions } = req.body;
  if (!company_id || !Array.isArray(transactions)) return res.status(400).json({ success: false, message: 'Invalid data' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;

    for (const trx of transactions) {
      if (!trx.NoTransaksi) continue;
      await client.query(`
        INSERT INTO sales (company_id, transaction_no, transaction_date, customer_name, product_name, qty, price, discount, total, branch_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (company_id, transaction_no) DO UPDATE SET
          qty = EXCLUDED.qty,
          price = EXCLUDED.price,
          total = EXCLUDED.total;
      `, [
        company_id,
        trx.NoTransaksi,
        trx.Tanggal || new Date(),
        trx.Customer || 'Umum',
        trx.Produk || 'Produk',
        Number(trx.Qty) || 1,
        Number(trx.Harga) || 0,
        Number(trx.Diskon) || 0,
        Number(trx.Total) || 0,
        trx.Cabang || 'PUSAT'
      ]);
      inserted++;
    }

    await client.query('COMMIT');
    console.log(`\n📦 SUKSES! ${inserted} Data Transaksi ${company_id} tersimpan ke PostgreSQL!`);
    res.json({ success: true, message: `Berhasil mengimpor ${inserted} transaksi ke database!` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// 4. ENDPOINT API DASHBOARD ANALYTICS (HITUNG OTOMATIS DARI NEON)
app.get('/api/dashboard/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const client = await pool.connect();
  try {
    const compRes = await client.query('SELECT * FROM companies WHERE company_id = $1', [companyId]);
    const company = compRes.rows[0] || { company_id: companyId, company_name: 'Unknown Company' };

    const modRes = await client.query('SELECT module_code, module_name, status FROM modules WHERE company_id = $1', [companyId]);

    const kpiRes = await client.query(`
      SELECT 
        COALESCE(SUM(total), 0) AS total_revenue,
        COUNT(id) AS total_trx,
        COALESCE(SUM(qty), 0) AS total_qty
      FROM sales WHERE company_id = $1
    `, [companyId]);

    const topProdRes = await client.query(`
      SELECT product_name, SUM(qty) as total_sold
      FROM sales WHERE company_id = $1
      GROUP BY product_name ORDER BY total_sold DESC LIMIT 5
    `, [companyId]);

    const dailyRes = await client.query(`
      SELECT TO_CHAR(transaction_date, 'YYYY-MM-DD') as t_date, SUM(total) as daily_total
      FROM sales WHERE company_id = $1
      GROUP BY t_date ORDER BY t_date ASC LIMIT 14
    `, [companyId]);

    const trxRes = await client.query(`
      SELECT transaction_no, transaction_date, customer_name, product_name, qty, total, branch_code
      FROM sales WHERE company_id = $1
      ORDER BY id DESC LIMIT 10
    `, [companyId]);

    res.json({
      success: true,
      company: company,
      modules: modRes.rows,
      kpi: {
        totalRevenue: Number(kpiRes.rows[0]?.total_revenue || 0),
        totalTrx: Number(kpiRes.rows[0]?.total_trx || 0),
        totalQty: Number(kpiRes.rows[0]?.total_qty || 0),
        topProduct: topProdRes.rows[0]?.product_name || '-'
      },
      charts: {
        daily: {
          labels: dailyRes.rows.map(r => r.t_date),
          values: dailyRes.rows.map(r => Number(r.daily_total))
        },
        topProducts: {
          labels: topProdRes.rows.map(r => r.product_name),
          values: topProdRes.rows.map(r => Number(r.total_sold))
        }
      },
      transactions: trxRes.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

app.listen(PORT, () => {
  console.log('=========================================');
  console.log(`🚀 Server Vanguard aktif di: http://localhost:${PORT}`);
  console.log('=========================================');
});