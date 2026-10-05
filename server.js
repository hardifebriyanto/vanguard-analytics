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

// KONEKSI NEON CLOUD DATABASE (POOLING AMAN UNTUK VERCEL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_u3R7sCfltVvd@ep-dry-frog-a10j192k-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// AUTO MIGRATION: Menjamin semua tabel & kolom otomatis ada tanpa error
async function ensureTables() {
  try {
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
      );
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
      );
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_code ON branches(company_id, branch_code);`).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS modules (
        id SERIAL PRIMARY KEY,
        company_id VARCHAR(50) NOT NULL,
        module_code VARCHAR(50) NOT NULL,
        module_name VARCHAR(100) NOT NULL,
        is_enabled BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_modules_code ON modules(company_id, module_code);`).catch(() => {});

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
      );
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_trx_id ON sales_transactions(company_id, trx_id);`).catch(() => {});

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
      );
    `);

    // Pastikan kolom-kolom baru selalu ada
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC(15,2) DEFAULT 0;`).catch(() => {});
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_in INTEGER DEFAULT 0;`).catch(() => {});
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_sold INTEGER DEFAULT 0;`).catch(() => {});
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS current_stock INTEGER DEFAULT 0;`).catch(() => {});
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(100) DEFAULT 'Umum';`).catch(() => {});
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_code ON products(company_id, product_code);`).catch(() => {});
  } catch (err) {
    console.error('ensureTables warning:', err.message);
  }
}
ensureTables();

// 1. ENDPOINT KOSONGKAN PRODUK
app.post('/api/pos/reset-products', async (req, res) => {
  const { company_id = 'COMP-001' } = req.body;
  try {
    await pool.query('DELETE FROM products WHERE company_id = $1', [company_id]);
    res.json({ success: true, message: 'Semua produk telah dikosongkan menjadi 0.' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// 2. ENDPOINT KOSONGKAN TRANSAKSI
app.post('/api/reset-sales', async (req, res) => {
  const { company_id = 'COMP-001' } = req.body;
  try {
    await pool.query('DELETE FROM sales_transactions WHERE company_id = $1', [company_id]);
    await pool.query('UPDATE products SET stock_sold = 0, current_stock = stock_in WHERE company_id = $1', [company_id]);
    res.json({ success: true, message: 'Semua data transaksi di-reset menjadi 0!' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// 3. SINKRONISASI DATA DARI GOOGLE APPS SCRIPT (Tab PRODUCTS, BRANCHES, dll)
app.post('/api/sync/config', async (req, res) => {
  try {
    const { company, modules, branches, products } = req.body;
    if (!company || !company.company_id) {
      return res.json({ success: false, message: 'Data company tidak valid' });
    }

    await ensureTables();

    // Upsert Profil Perusahaan
    await pool.query(`
      INSERT INTO companies (company_id, company_name, plan_tier, logo_url, address, phone, email, status, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
      ON CONFLICT (company_id) DO UPDATE SET
        company_name = EXCLUDED.company_name,
        plan_tier = EXCLUDED.plan_tier,
        logo_url = EXCLUDED.logo_url,
        address = EXCLUDED.address,
        phone = EXCLUDED.phone,
        email = EXCLUDED.email,
        status = EXCLUDED.status,
        updated_at = CURRENT_TIMESTAMP
    `, [
      company.company_id,
      company.company_name,
      company.plan_tier || 'BASIC',
      company.logo_url || '',
      company.address || '',
      company.phone || '',
      company.email || '',
      company.status || 'ACTIVE'
    ]);

    // Upsert 5 Cabang
    if (Array.isArray(branches) && branches.length > 0) {
      for (const b of branches) {
        if (!b.branch_code) continue;
        await pool.query(`
          INSERT INTO branches (company_id, branch_id, branch_code, branch_name, city)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (company_id, branch_code) DO UPDATE SET
            branch_id = EXCLUDED.branch_id,
            branch_name = EXCLUDED.branch_name,
            city = EXCLUDED.city
        `, [
          company.company_id,
          b.branch_id || b.branch_code,
          b.branch_code,
          b.branch_name || b.branch_code,
          b.city || ''
        ]);
      }
    }

    // Upsert Modul
    if (Array.isArray(modules) && modules.length > 0) {
      for (const m of modules) {
        if (!m.module_code) continue;
        await pool.query(`
          INSERT INTO modules (company_id, module_code, module_name, is_enabled)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (company_id, module_code) DO UPDATE SET
            module_name = EXCLUDED.module_name,
            is_enabled = EXCLUDED.is_enabled
        `, [
          company.company_id,
          m.module_code,
          m.module_name || m.module_code,
          m.is_enabled === true || m.is_enabled === 'true'
        ]);
      }
    }

    // Upsert Produk dari Tab PRODUCTS Google Sheets
    if (Array.isArray(products) && products.length > 0) {
      for (const p of products) {
        if (!p.product_code || !p.product_name) continue;
        const stockIn = Number(p.stock_in || 0);
        const price = Number(p.price || 0);
        const costPrice = Number(p.cost_price || 0);

        await pool.query(`
          INSERT INTO products (company_id, product_code, product_name, category, price, cost_price, stock_in, current_stock, unit, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'pcs', CURRENT_TIMESTAMP)
          ON CONFLICT (company_id, product_code) DO UPDATE SET
            product_name = EXCLUDED.product_name,
            category = EXCLUDED.category,
            price = EXCLUDED.price,
            cost_price = EXCLUDED.cost_price,
            stock_in = EXCLUDED.stock_in,
            current_stock = EXCLUDED.stock_in - COALESCE(products.stock_sold, 0),
            updated_at = CURRENT_TIMESTAMP
        `, [
          company.company_id,
          p.product_code,
          p.product_name,
          p.category || 'Umum',
          price,
          costPrice,
          stockIn
        ]);
      }
    }

    return res.json({ success: true, message: 'Data Master & Produk dari Spreadsheet berhasil disinkronkan!' });
  } catch (err) {
    console.error('Sync config error:', err);
    return res.json({ success: false, message: 'Gagal sync: ' + err.message });
  }
});

// 4. DAFTAR PRODUK KASIR POS
app.get('/api/pos/products/:companyId', async (req, res) => {
  const { companyId } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT product_code, product_name, category, price, cost_price, stock_in, stock_sold, current_stock, unit FROM products WHERE company_id = $1 ORDER BY id ASC',
      [companyId]
    );
    res.json({ success: true, products: rows });
  } catch (err) {
    res.json({ success: false, message: err.message, products: [] });
  }
});

// 5. TAMBAH / UPDATE PRODUK DARI KASIR
app.post('/api/pos/products', async (req, res) => {
  const { company_id = 'COMP-001', product_code, product_name, category, price, cost_price = 0, stock_in = 0 } = req.body;
  try {
    await pool.query(`
      INSERT INTO products (company_id, product_code, product_name, category, price, cost_price, stock_in, current_stock, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $7, CURRENT_TIMESTAMP)
      ON CONFLICT (company_id, product_code) DO UPDATE SET
        product_name = EXCLUDED.product_name,
        category = EXCLUDED.category,
        price = EXCLUDED.price,
        cost_price = EXCLUDED.cost_price,
        stock_in = products.stock_in + EXCLUDED.stock_in,
        current_stock = (products.stock_in + EXCLUDED.stock_in) - products.stock_sold,
        updated_at = CURRENT_TIMESTAMP
    `, [company_id, product_code, product_name, category || 'Umum', price, cost_price, stock_in]);

    res.json({ success: true, message: 'Produk & stok berhasil disimpan!' });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// 6. CHECKOUT TRANSAKSI KASIR
app.post('/api/pos/checkout', async (req, res) => {
  try {
    const { company_id = 'COMP-001', branch_name, customer_name, payment_method, items } = req.body;
    if (!items || items.length === 0) return res.json({ success: false, message: 'Item pesanan kosong' });

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

// 7. DASHBOARD DATA
app.get('/api/dashboard/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const { branch } = req.query;

  try {
    const compRes = await pool.query('SELECT * FROM companies WHERE company_id = $1', [companyId]);
    const company = compRes.rows[0] || { company_id: companyId, company_name: 'VARDHANA NIRWANA' };

    const branchRes = await pool.query('SELECT * FROM branches WHERE company_id = $1 ORDER BY id ASC', [companyId]);
    const moduleRes = await pool.query('SELECT * FROM modules WHERE company_id = $1 ORDER BY id ASC', [companyId]);

    const perfQuery = `
      SELECT COALESCE(branch_name, branch_code) as branch_code, SUM(total_amount) as total_revenue, COUNT(*) as total_trx
      FROM sales_transactions WHERE company_id = $1 GROUP BY COALESCE(branch_name, branch_code)
    `;
    const perfRes = await pool.query(perfQuery, [companyId]);

    let trxQuery = 'SELECT * FROM sales_transactions WHERE company_id = $1';
    const params = [companyId];
    if (branch) {
      params.push(branch);
      trxQuery += ' AND (branch_name = $2 OR branch_code = $2)';
    }
    trxQuery += ' ORDER BY trx_date DESC, id DESC LIMIT 50';
    const trxRes = await pool.query(trxQuery, params);

    let kpiQuery = `
      SELECT COALESCE(SUM(total_amount), 0) as total_revenue, COUNT(*) as total_trx, COALESCE(SUM(qty), 0) as total_qty
      FROM sales_transactions WHERE company_id = $1
    `;
    const kpiParams = [companyId];
    if (branch) {
      kpiParams.push(branch);
      kpiQuery += ' AND (branch_name = $2 OR branch_code = $2)';
    }
    const kpiRes = await pool.query(kpiQuery, kpiParams);
    const kpiRow = kpiRes.rows[0] || {};

    let topQuery = `
      SELECT product_name, SUM(qty) as sum_qty FROM sales_transactions WHERE company_id = $1
    `;
    const topParams = [companyId];
    if (branch) {
      topParams.push(branch);
      topQuery += ' AND (branch_name = $2 OR branch_code = $2)';
    }
    topQuery += ' GROUP BY product_name ORDER BY sum_qty DESC LIMIT 1';
    const topRes = await pool.query(topQuery, topParams);

    let dailyQuery = `
      SELECT trx_date::text as day, SUM(total_amount) as amount FROM sales_transactions WHERE company_id = $1
    `;
    const dailyParams = [companyId];
    if (branch) {
      dailyParams.push(branch);
      dailyQuery += ' AND (branch_name = $2 OR branch_code = $2)';
    }
    dailyQuery += ' GROUP BY trx_date ORDER BY trx_date ASC LIMIT 7';
    const dailyRes = await pool.query(dailyQuery, dailyParams);

    let prodChartQuery = `
      SELECT product_name, SUM(qty) as sum_qty FROM sales_transactions WHERE company_id = $1
    `;
    const prodParams = [companyId];
    if (branch) {
      prodParams.push(branch);
      prodChartQuery += ' AND (branch_name = $2 OR branch_code = $2)';
    }
    prodChartQuery += ' GROUP BY product_name ORDER BY sum_qty DESC LIMIT 5';
    const prodChartRes = await pool.query(prodChartQuery, prodParams);

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
        daily: {
          labels: dailyRes.rows.map(r => r.day),
          values: dailyRes.rows.map(r => Number(r.amount))
        },
        topProducts: {
          labels: prodChartRes.rows.map(r => r.product_name),
          values: prodChartRes.rows.map(r => Number(r.sum_qty))
        }
      }
    });

  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Fallback Routes
app.get('/pos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pos.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
}

// INI KUNCI UTAMA AGAR VERCEL TIDAK FUNCTION_INVOCATION_FAILED:
export default app;
