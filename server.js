import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Helper: Pastikan Tenant & Cabang Otomatis Terdaftar jika Baru
async function ensureCompanyAndBranch(client, companyId, companyName = null) {
  const cleanId = String(companyId || 'COMP-001').trim();
  const displayName = companyName || cleanId.toUpperCase().replace(/-/g, ' ');

  // 1. Cek / Buat Company
  const compCheck = await client.query('SELECT company_id FROM companies WHERE company_id = $1', [cleanId]);
  if (compCheck.rows.length === 0) {
    await client.query(
      `INSERT INTO companies (company_id, name, plan_tier) VALUES ($1, $2, 'PRO')`,
      [cleanId, displayName]
    );
  }

  // 2. Cek / Buat Cabang Utama Default
  const branchCheck = await client.query('SELECT branch_id FROM branches WHERE company_id = $1', [cleanId]);
  if (branchCheck.rows.length === 0) {
    await client.query(
      `INSERT INTO branches (branch_id, company_id, name, address) VALUES ($1, $2, $3, $4)`,
      ['BR-001', cleanId, 'Cabang Utama', 'Pusat Operasional']
    );
  }
}

// 1. INIT POS (Load Toko, Cabang, dan Produk)
app.get('/api/pos/init/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const client = await pool.connect();
  try {
    await ensureCompanyAndBranch(client, companyId);

    const compRes = await client.query('SELECT company_id, name, plan_tier FROM companies WHERE company_id = $1', [companyId]);
    const branchRes = await client.query('SELECT branch_id, name FROM branches WHERE company_id = $1 ORDER BY branch_id ASC', [companyId]);
    const prodRes = await client.query(
      'SELECT product_id, name, category, unit_price, stock_in, stock_sold, current_stock FROM products WHERE company_id = $1 AND is_active = true ORDER BY name ASC',
      [companyId]
    );

    res.json({
      success: true,
      company: compRes.rows[0] || { company_id: companyId, name: companyId },
      branches: branchRes.rows || [],
      products: prodRes.rows || []
    });
  } catch (err) {
    console.error('POS Init Error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 2. SYNC PRODUK DARI GOOGLE SPREADSHEET
app.post('/api/pos/sync-products', async (req, res) => {
  const { company_id, products, company_name } = req.body;
  if (!company_id || !Array.isArray(products)) {
    return res.status(400).json({ success: false, error: 'company_id and products array are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Pastikan Tenant & Cabang Ada
    await ensureCompanyAndBranch(client, company_id, company_name);

    for (const p of products) {
      const pId = String(p.product_id).trim();
      const pName = String(p.name).trim();
      const pCat = String(p.category || 'Umum').trim();
      const pPrice = Number(p.unit_price || 0);
      const sIn = Number(p.stock_in || 0);
      const sSold = Number(p.stock_sold || 0);
      let cStock = Number(p.current_stock);
      if (isNaN(cStock)) cStock = sIn - sSold;

      const check = await client.query(
        'SELECT product_id FROM products WHERE company_id = $1 AND product_id = $2',
        [company_id, pId]
      );

      if (check.rows.length > 0) {
        await client.query(
          `UPDATE products 
           SET name = $1, category = $2, unit_price = $3, stock_in = $4, stock_sold = $5, current_stock = $6, is_active = true, updated_at = NOW()
           WHERE company_id = $7 AND product_id = $8`,
          [pName, pCat, pPrice, sIn, sSold, cStock, company_id, pId]
        );
      } else {
        await client.query(
          `INSERT INTO products (product_id, company_id, name, category, unit_price, stock_in, stock_sold, current_stock, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
          [pId, company_id, pName, pCat, pPrice, sIn, sSold, cStock]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, count: products.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Sync Products Error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 3. CHECKOUT TRANSAKSI KASIR
app.post('/api/pos/checkout', async (req, res) => {
  const { company_id, branch_id, cashier_name, payment_method, total_amount, items } = req.body;
  if (!company_id || !branch_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'Data transaksi tidak lengkap' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const trxId = 'TRX-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase();

    // Simpan Header Transaksi
    await client.query(
      `INSERT INTO transactions (trx_id, company_id, branch_id, cashier_name, total_amount, payment_method, items, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [trxId, company_id, branch_id, cashier_name || 'Kasir', total_amount, payment_method || 'CASH', JSON.stringify(items)]
    );

    // Potong Stok Produk
    for (const item of items) {
      const pId = String(item.product_id).trim();
      const qty = Number(item.quantity || item.qty || 1);

      await client.query(
        `UPDATE products 
         SET stock_sold = COALESCE(stock_sold, 0) + $1,
             current_stock = GREATEST(0, COALESCE(current_stock, 0) - $1),
             updated_at = NOW()
         WHERE company_id = $2 AND product_id = $3`,
        [qty, company_id, pId]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, trx_id: trxId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Checkout Error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 4. PULL DATA PENJUALAN & STOK KE GOOGLE SPREADSHEET
app.get('/api/sync/pull/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const client = await pool.connect();
  try {
    const trxRes = await client.query(
      `SELECT t.trx_id, t.created_at, b.name as branch_name, t.cashier_name, t.total_amount, t.payment_method, t.items
       FROM transactions t
       LEFT JOIN branches b ON t.branch_id = b.branch_id AND t.company_id = b.company_id
       WHERE t.company_id = $1
       ORDER BY t.created_at DESC`,
      [companyId]
    );

    const prodRes = await client.query(
      `SELECT product_id, name, stock_in, stock_sold, current_stock 
       FROM products 
       WHERE company_id = $1`,
      [companyId]
    );

    res.json({
      success: true,
      transactions: trxRes.rows || [],
      products: prodRes.rows || []
    });
  } catch (err) {
    console.error('Pull Sync Error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 5. DASHBOARD ANALYTICS
app.get('/api/dashboard/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const client = await pool.connect();
  try {
    await ensureCompanyAndBranch(client, companyId);

    const compRes = await client.query('SELECT company_id, name, plan_tier FROM companies WHERE company_id = $1', [companyId]);
    const branchRes = await client.query('SELECT branch_id, name FROM branches WHERE company_id = $1', [companyId]);
    const trxRes = await client.query(
      `SELECT t.trx_id, t.created_at, t.branch_id, b.name as branch_name, t.cashier_name, t.total_amount, t.payment_method, t.items
       FROM transactions t
       LEFT JOIN branches b ON t.branch_id = b.branch_id AND t.company_id = b.company_id
       WHERE t.company_id = $1
       ORDER BY t.created_at DESC`,
      [companyId]
    );
    const prodRes = await client.query(
      `SELECT product_id, name as product_name, category, unit_price, stock_in, stock_sold, current_stock 
       FROM products 
       WHERE company_id = $1
       ORDER BY name ASC`,
      [companyId]
    );

    res.json({
      success: true,
      company: compRes.rows[0] || { company_id: companyId, name: companyId },
      branches: branchRes.rows || [],
      transactions: trxRes.rows || [],
      inventory: prodRes.rows || []
    });
  } catch (err) {
    console.error('Dashboard Error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

export default app;
