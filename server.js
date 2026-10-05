import express from 'express';
import cors from 'cors';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// KONEKSI DATABASE NEON CLOUD (FAST POOLING)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_u3R7sCfltVvd@ep-dry-frog-a10j192k-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// 1. ENDPOINT SYNC KHUSUS PRODUK (OTOMATIS MEMBUAT TABEL PRODUCTS JIKA BELUM ADA)
app.post('/api/pos/sync-products', async (req, res) => {
  try {
    const { company_id = 'COMP-001', products = [] } = req.body;
    if (!products.length) return res.json({ success: false, message: 'Tidak ada data produk yang dikirim.' });

    // OTOMATIS BUAT TABEL PRODUCTS JIKA BELUM TERSEDIA
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        company_id VARCHAR(50) NOT NULL,
        product_code VARCHAR(50) NOT NULL,
        product_name VARCHAR(255) NOT NULL,
        category VARCHAR(100) DEFAULT 'Umum',
        cost_price NUMERIC(15,2) DEFAULT 0,
        price NUMERIC(15,2) NOT NULL DEFAULT 0,
        stock_in INTEGER DEFAULT 0,
        stock_sold INTEGER DEFAULT 0,
        current_stock INTEGER DEFAULT 0,
        unit VARCHAR(20) DEFAULT 'pcs',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // PROSES SETIAP PRODUK DARI GOOGLE SPREADSHEET
    for (const p of products) {
      if (!p.product_code || !p.product_name) continue;
      const stockIn = Number(p.stock_in || 0);
      const price = Number(p.price || 0);
      const costPrice = Number(p.cost_price || 0);

      // Coba UPDATE jika produk sudah ada
      const up = await pool.query(`
        UPDATE products 
        SET product_name = $1, category = $2, price = $3, cost_price = $4, 
            stock_in = $5, current_stock = $5 - COALESCE(stock_sold, 0), updated_at = CURRENT_TIMESTAMP
        WHERE company_id = $6 AND product_code = $7
      `, [p.product_name, p.category || 'Umum', price, costPrice, stockIn, company_id, p.product_code]);

      // Jika belum ada, lakukan INSERT produk baru
      if (up.rowCount === 0) {
        await pool.query(`
          INSERT INTO products (company_id, product_code, product_name, category, price, cost_price, stock_in, current_stock, unit, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'pcs', CURRENT_TIMESTAMP)
        `, [company_id, p.product_code, p.product_name, p.category || 'Umum', price, costPrice, stockIn]);
      }
    }

    res.json({ success: true, message: `Berhasil sinkronisasi ${products.length} produk ke Kasir Cloud!` });
  } catch (err) {
    res.json({ success: false, message: 'Gagal sync produk: ' + err.message });
  }
});

// 2. ENDPOINT SYNC MASTER CONFIG (PERUSAHAAN, CABANG & MODUL)
app.post('/api/sync/config', async (req, res) => {
  try {
    const { company, modules, branches, products } = req.body;
    if (!company) return res.json({ success: false, message: 'Data tidak valid' });

    // Pastikan tabel master ada
    await pool.query(`
      CREATE TABLE IF NOT EXISTS companies (
        company_id VARCHAR(50) PRIMARY KEY,
        company_name VARCHAR(255) NOT NULL,
        plan_tier VARCHAR(50) DEFAULT 'BASIC',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        logo_url TEXT,
        address TEXT,
        phone VARCHAR(50),
        email VARCHAR(100),
        status VARCHAR(50) DEFAULT 'ACTIVE'
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id SERIAL PRIMARY KEY,
        company_id VARCHAR(50) NOT NULL,
        branch_id VARCHAR(50),
        branch_code VARCHAR(50) NOT NULL,
        branch_name VARCHAR(255) NOT NULL,
        city VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS modules (
        id SERIAL PRIMARY KEY,
        company_id VARCHAR(50) NOT NULL,
        module_code VARCHAR(50) NOT NULL,
        module_name VARCHAR(100) NOT NULL,
        is_enabled BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Update Company
    const compUp = await pool.query(`
      UPDATE companies 
      SET company_name = $1, plan_tier = $2, logo_url = $3, address = $4, phone = $5, email = $6, status = $7, updated_at = CURRENT_TIMESTAMP
      WHERE company_id = $8
    `, [company.company_name, company.plan_tier || 'BASIC', company.logo_url || '', company.address || '', company.phone || '', company.email || '', company.status || 'ACTIVE', company.company_id]);

    if (compUp.rowCount === 0) {
      await pool.query(`
        INSERT INTO companies (company_id, company_name, plan_tier, logo_url, address, phone, email, status, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
      `, [company.company_id, company.company_name, company.plan_tier || 'BASIC', company.logo_url || '', company.address || '', company.phone || '', company.email || '', company.status || 'ACTIVE']);
    }

    // Refresh Cabang
    if (branches && branches.length) {
      await pool.query('DELETE FROM branches WHERE company_id = $1', [company.company_id]);
      for (const b of branches) {
        if (!b.branch_code) continue;
        await pool.query(`
          INSERT INTO branches (company_id, branch_id, branch_code, branch_name, city)
          VALUES ($1, $2, $3, $4, $5)
        `, [company.company_id, b.branch_id || b.branch_code, b.branch_code, b.branch_name || b.branch_code, b.city || '']);
      }
    }

    // Refresh Modul
    if (modules && modules.length) {
      await pool.query('DELETE FROM modules WHERE company_id = $1', [company.company_id]);
      for (const m of modules) {
        if (!m.module_code) continue;
        await pool.query(`
          INSERT INTO modules (company_id, module_code, module_name, is_enabled)
          VALUES ($1, $2, $3, $4)
        `, [company.company_id, m.module_code, m.module_name || m.module_code, m.is_enabled === true || m.is_enabled === 'true']);
      }
    }

    res.json({ success: true, message: 'Seluruh data master berhasil disinkronkan!' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// 3. DAFTAR PRODUK KASIR
app.get('/api/pos/products/:companyId', async (req, res) => {
  const { companyId } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT product_code, product_name, category, price, cost_price, stock_in, stock_sold, current_stock, unit FROM products WHERE company_id = $1 ORDER BY id ASC',
      [companyId]
    );
    res.json({ success: true, products: rows });
  } catch (err) {
    res.json({ success: true, products: [] });
  }
});

// 4. CHECKOUT TRANSAKSI KASIR
app.post('/api/pos/checkout', async (req, res) => {
  try {
    const { company_id = 'COMP-001', branch_name, customer_name, payment_method, items } = req.body;
    if (!items || !items.length) return res.json({ success: false, message: 'Item pesanan kosong' });

    // Pastikan tabel transaksi ada
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales_transactions (
        id SERIAL PRIMARY KEY,
        company_id VARCHAR(50) NOT NULL,
        trx_id VARCHAR(100) NOT NULL,
        trx_date DATE NOT NULL,
        customer_name VARCHAR(255),
        product_name VARCHAR(255) NOT NULL,
        category VARCHAR(100),
        qty INTEGER NOT NULL DEFAULT 1,
        price NUMERIC(15, 2) NOT NULL DEFAULT 0,
        total_amount NUMERIC(15, 2) NOT NULL DEFAULT 0,
        payment_method VARCHAR(50),
        branch_code VARCHAR(50),
        branch_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const trxId = 'TRX-' + Date.now().toString().slice(-6);
    const today = new Date().toISOString().split('T')[0];

    for (const item of items) {
      const qty = Number(item.qty || 1);
      const price = Number(item.price || 0);
      const total = qty * price;

      await pool.query(`
        INSERT INTO sales_transactions (company_id, trx_id, trx_date, customer_name, product_name, category, qty, price, total_amount, payment_method, branch_name, branch_code)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
      `, [company_id, `${trxId}-${item.product_code}`, today, customer_name || 'Umum', item.product_name, 'POS', qty, price, total, payment_method, branch_name]);

      await pool.query(`
        UPDATE products 
        SET stock_sold = stock_sold + $1, current_stock = current_stock - $1, updated_at = CURRENT_TIMESTAMP
        WHERE company_id = $2 AND product_code = $3
      `, [qty, company_id, item.product_code]);
    }

    res.json({ success: true, trx_id: trxId, message: 'Transaksi berhasil disimpan ke cloud' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// 5. DASHBOARD DATA
app.get('/api/dashboard/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const { branch } = req.query;

  try {
    const compRes = await pool.query('SELECT * FROM companies WHERE company_id = $1', [companyId]).catch(() => ({ rows: [] }));
    const company = compRes.rows[0] || { company_id: companyId, company_name: 'VARDHANA NIRWANA' };

    const branchRes = await pool.query('SELECT * FROM branches WHERE company_id = $1 ORDER BY id ASC', [companyId]).catch(() => ({ rows: [] }));
    const moduleRes = await pool.query('SELECT * FROM modules WHERE company_id = $1 ORDER BY id ASC', [companyId]).catch(() => ({ rows: [] }));

    const perfRes = await pool.query(`
      SELECT COALESCE(branch_name, branch_code) as branch_code, SUM(total_amount) as total_revenue, COUNT(*) as total_trx
      FROM sales_transactions WHERE company_id = $1 GROUP BY COALESCE(branch_name, branch_code)
    `, [companyId]).catch(() => ({ rows: [] }));

    let trxQuery = 'SELECT * FROM sales_transactions WHERE company_id = $1';
    const params = [companyId];
    if (branch) {
      params.push(branch);
      trxQuery += ' AND (branch_name = $2 OR branch_code = $2)';
    }
    trxQuery += ' ORDER BY trx_date DESC, id DESC LIMIT 50';
    const trxRes = await pool.query(trxQuery, params).catch(() => ({ rows: [] }));

    let kpiQuery = `
      SELECT COALESCE(SUM(total_amount), 0) as total_revenue, COUNT(*) as total_trx, COALESCE(SUM(qty), 0) as total_qty
      FROM sales_transactions WHERE company_id = $1
    `;
    const kpiParams = [companyId];
    if (branch) {
      kpiParams.push(branch);
      kpiQuery += ' AND (branch_name = $2 OR branch_code = $2)';
    }
    const kpiRes = await pool.query(kpiQuery, kpiParams).catch(() => ({ rows: [{}] }));
    const kpiRow = kpiRes.rows[0] || {};

    let topQuery = `SELECT product_name, SUM(qty) as sum_qty FROM sales_transactions WHERE company_id = $1`;
    const topParams = [companyId];
    if (branch) {
      topParams.push(branch);
      topQuery += ' AND (branch_name = $2 OR branch_code = $2)';
    }
    topQuery += ' GROUP BY product_name ORDER BY sum_qty DESC LIMIT 1';
    const topRes = await pool.query(topQuery, topParams).catch(() => ({ rows: [] }));

    let dailyQuery = `SELECT trx_date::text as day, SUM(total_amount) as amount FROM sales_transactions WHERE company_id = $1`;
    const dailyParams = [companyId];
    if (branch) {
      dailyParams.push(branch);
      dailyQuery += ' AND (branch_name = $2 OR branch_code = $2)';
    }
    dailyQuery += ' GROUP BY trx_date ORDER BY trx_date ASC LIMIT 7';
    const dailyRes = await pool.query(dailyQuery, dailyParams).catch(() => ({ rows: [] }));

    let prodChartQuery = `SELECT product_name, SUM(qty) as sum_qty FROM sales_transactions WHERE company_id = $1`;
    const prodParams = [companyId];
    if (branch) {
      prodParams.push(branch);
      prodChartQuery += ' AND (branch_name = $2 OR branch_code = $2)';
    }
    prodChartQuery += ' GROUP BY product_name ORDER BY sum_qty DESC LIMIT 5';
    const prodChartRes = await pool.query(prodChartQuery, prodParams).catch(() => ({ rows: [] }));

    res.json({
      success: true,
      company,
      branches: branchRes.rows,
      modules: moduleRes.rows,
      branchPerformance: perfRes.rows,
      transactions: trxRes.rows,
      kpi: {
        totalRevenue: Number(kpiRow.total_revenue || 0),
        totalTrx: Number(kpiRow.total_trx || 0),
        totalQty: Number(kpiRow.total_qty || 0),
        topProduct: topRes.rows[0] ? topRes.rows[0].product_name : '-'
      },
      charts: {
        daily: { labels: dailyRes.rows.map(r => r.day), values: dailyRes.rows.map(r => Number(r.amount)) },
        topProducts: { labels: prodChartRes.rows.map(r => r.product_name), values: prodChartRes.rows.map(r => Number(r.sum_qty)) }
      }
    });

  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// 6. RESET DATA PENJUALAN
app.post('/api/reset-sales', async (req, res) => {
  const { company_id = 'COMP-001' } = req.body;
  await pool.query('DELETE FROM sales_transactions WHERE company_id = $1', [company_id]).catch(() => {});
  await pool.query('UPDATE products SET stock_sold = 0, current_stock = stock_in WHERE company_id = $1', [company_id]).catch(() => {});
  res.json({ success: true, message: 'Semua transaksi di-reset menjadi 0!' });
});

// Fallback Routes
app.get('/pos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pos.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

export default app;
