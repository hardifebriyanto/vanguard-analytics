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

// Helper: Auto-Register Tenant Baru & Cabang Default
async function ensureCompanyAndBranch(client, companyId, companyName = null) {
  const cleanId = String(companyId || 'COMP-001').trim();
  const displayName = companyName || cleanId;

  // 1. Cek Kolom yang ada di tabel companies
  const colRes = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'companies'`
  );
  const cols = colRes.rows.map(r => r.column_name.toLowerCase());

  // 2. Cek apakah company_id sudah terdaftar
  const compCheck = await client.query('SELECT company_id FROM companies WHERE company_id = $1', [cleanId]);
  if (compCheck.rows.length === 0) {
    const insertCols = ['company_id'];
    const insertVals = [cleanId];
    const placeholders = ['$1'];
    let idx = 2;

    if (cols.includes('company_name')) {
      insertCols.push('company_name');
      insertVals.push(displayName);
      placeholders.push(`$${idx++}`);
    } else if (cols.includes('name')) {
      insertCols.push('name');
      insertVals.push(displayName);
      placeholders.push(`$${idx++}`);
    }

    if (cols.includes('package_id')) {
      insertCols.push('package_id');
      insertVals.push('BASIC');
      placeholders.push(`$${idx++}`);
    } else if (cols.includes('plan_tier')) {
      insertCols.push('plan_tier');
      insertVals.push('PRO');
      placeholders.push(`$${idx++}`);
    }

    await client.query(
      `INSERT INTO companies (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')})`,
      insertVals
    );
  }

  // 3. Cek Kolom yang ada di tabel branches
  const bColRes = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'branches'`
  );
  const bCols = bColRes.rows.map(r => r.column_name.toLowerCase());

  // 4. Cek apakah Cabang sudah ada
  const branchCheck = await client.query('SELECT branch_id FROM branches WHERE company_id = $1', [cleanId]);
  if (branchCheck.rows.length === 0) {
    const bColsList = ['branch_id', 'company_id'];
    const bValsList = ['BR-001', cleanId];
    const bPlaceholders = ['$1', '$2'];
    let bIdx = 3;

    if (bCols.includes('branch_name')) {
      bColsList.push('branch_name');
      bValsList.push('Cabang Utama');
      bPlaceholders.push(`$${bIdx++}`);
    } else if (bCols.includes('name')) {
      bColsList.push('name');
      bValsList.push('Cabang Utama');
      bPlaceholders.push(`$${bIdx++}`);
    }

    await client.query(
      `INSERT INTO branches (${bColsList.join(', ')}) VALUES (${bPlaceholders.join(', ')})`,
      bValsList
    );
  }
}

// 1. INIT POS
app.get('/api/pos/init/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const client = await pool.connect();
  try {
    await ensureCompanyAndBranch(client, companyId);

    const compRes = await client.query('SELECT * FROM companies WHERE company_id = $1', [companyId]);
    const branchRes = await client.query('SELECT * FROM branches WHERE company_id = $1 ORDER BY branch_id ASC', [companyId]);
    const prodRes = await client.query(
      'SELECT product_id, name, category, unit_price, stock_in, stock_sold, current_stock FROM products WHERE company_id = $1 AND is_active = true ORDER BY name ASC',
      [companyId]
    );

    const comp = compRes.rows[0] || {};
    const branches = branchRes.rows.map(b => ({
      branch_id: b.branch_id,
      name: b.branch_name || b.name || b.branch_id
    }));

    res.json({
      success: true,
      company: {
        company_id: companyId,
        name: comp.company_name || comp.name || companyId
      },
      branches: branches,
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

    // Auto-create company & branch jika belum ada di database
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

    await client.query(
      `INSERT INTO transactions (trx_id, company_id, branch_id, cashier_name, total_amount, payment_method, items, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [trxId, company_id, branch_id, cashier_name || 'Kasir', total_amount, payment_method || 'CASH', JSON.stringify(items)]
    );

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

// 4. PULL DATA KE GOOGLE SPREADSHEET
app.get('/api/sync/pull/:companyId', async (req, res) => {
  const { companyId } = req.params;
  const client = await pool.connect();
  try {
    const branchRes = await client.query('SELECT branch_id, branch_name FROM branches WHERE company_id = $1', [companyId]).catch(() => ({ rows: [] }));
    const branchMap = {};
    (branchRes.rows || []).forEach(b => {
      branchMap[b.branch_id] = b.branch_name || b.name || b.branch_id;
    });

    const trxRes = await client.query(
      `SELECT trx_id, created_at, branch_id, cashier_name, total_amount, payment_method, items
       FROM transactions
       WHERE company_id = $1
       ORDER BY created_at DESC`,
      [companyId]
    );

    const prodRes = await client.query(
      `SELECT product_id, name, stock_in, stock_sold, current_stock 
       FROM products 
       WHERE company_id = $1`,
      [companyId]
    );

    const transactions = trxRes.rows.map(t => ({
      ...t,
      branch_name: branchMap[t.branch_id] || 'Cabang Utama'
    }));

    res.json({
      success: true,
      transactions: transactions,
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

    const compRes = await client.query('SELECT * FROM companies WHERE company_id = $1', [companyId]);
    const branchRes = await client.query('SELECT * FROM branches WHERE company_id = $1', [companyId]);
    const trxRes = await client.query(
      `SELECT trx_id, created_at, branch_id, cashier_name, total_amount, payment_method, items
       FROM transactions
       WHERE company_id = $1
       ORDER BY created_at DESC`,
      [companyId]
    );
    const prodRes = await client.query(
      `SELECT product_id, name as product_name, category, unit_price, stock_in, stock_sold, current_stock 
       FROM products 
       WHERE company_id = $1
       ORDER BY name ASC`,
      [companyId]
    );

    const comp = compRes.rows[0] || {};
    const branches = branchRes.rows.map(b => ({
      branch_id: b.branch_id,
      name: b.branch_name || b.name || b.branch_id
    }));

    const branchMap = {};
    branches.forEach(b => { branchMap[b.branch_id] = b.name; });

    const transactions = trxRes.rows.map(t => ({
      ...t,
      branch_name: branchMap[t.branch_id] || 'Cabang Utama'
    }));

    res.json({
      success: true,
      company: {
        company_id: companyId,
        name: comp.company_name || comp.name || companyId
      },
      branches: branches,
      transactions: transactions,
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
