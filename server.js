import express from 'express';
import cors from 'cors';
import pg from 'pg';

const { Pool } = pg;
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database Connection Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Helper 1: Migrasi Mandiri & Penyesuaian Kolom
async function runMigration() {
  try {
    await pool.query(`ALTER TABLE products DROP CONSTRAINT IF EXISTS fk_company CASCADE`).catch(() => {});
    await pool.query(`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_company_id_fkey CASCADE`).catch(() => {});
    await pool.query(`ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_company_id_fkey CASCADE`).catch(() => {});
    await pool.query(`ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_company_id_fkey CASCADE`).catch(() => {});

    await pool.query(`ALTER TABLE companies ALTER COLUMN company_id TYPE VARCHAR(100) USING company_id::VARCHAR`).catch(() => {});
    await pool.query(`ALTER TABLE branches ALTER COLUMN company_id TYPE VARCHAR(100) USING company_id::VARCHAR`).catch(() => {});
    await pool.query(`ALTER TABLE products ALTER COLUMN company_id TYPE VARCHAR(100) USING company_id::VARCHAR`).catch(() => {});
    await pool.query(`ALTER TABLE transactions ALTER COLUMN company_id TYPE VARCHAR(100) USING company_id::VARCHAR`).catch(() => {});

    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS product_code VARCHAR(100)`).catch(() => {});
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS product_name VARCHAR(255)`).catch(() => {});
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS price NUMERIC DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_in NUMERIC DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_sold NUMERIC DEFAULT 0`).catch(() => {});
    await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS current_stock NUMERIC DEFAULT 0`).catch(() => {});
  } catch (e) {
    console.warn('Migration Notice:', e.message);
  }
}

// Helper 2: Pastikan Company dan Cabang Default Terdaftar
async function ensureCompanyAndBranch(companyId, companyName = null) {
  const cleanId = String(companyId || 'COMP-001').trim();
  const displayName = companyName || cleanId;

  const compCheck = await pool.query('SELECT * FROM companies WHERE company_id::VARCHAR = $1', [cleanId]);
  if (compCheck.rows.length === 0) {
    const colRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'companies'`
    );
    const cols = colRes.rows.map(r => r.column_name.toLowerCase());

    const insertCols = ['company_id'];
    const insertVals = [cleanId];
    const placeholders = ['$1'];
    let idx = 2;

    if (cols.includes('company_name')) { insertCols.push('company_name'); insertVals.push(displayName); placeholders.push(`$${idx++}`); }
    else if (cols.includes('name')) { insertCols.push('name'); insertVals.push(displayName); placeholders.push(`$${idx++}`); }

    if (cols.includes('package_id')) { insertCols.push('package_id'); insertVals.push('BASIC'); placeholders.push(`$${idx++}`); }
    else if (cols.includes('plan_tier')) { insertCols.push('plan_tier'); insertVals.push('PRO'); placeholders.push(`$${idx++}`); }

    await pool.query(
      `INSERT INTO companies (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')})`,
      insertVals
    );
  }

  const branchCheck = await pool.query('SELECT * FROM branches WHERE company_id::VARCHAR = $1', [cleanId]);
  if (branchCheck.rows.length === 0) {
    const bColRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'branches'`
    );
    const bCols = bColRes.rows.map(r => r.column_name.toLowerCase());

    const bColsList = ['branch_id', 'company_id'];
    const bValsList = ['BR-001', cleanId];
    const bPlaceholders = ['$1', '$2'];
    let bIdx = 3;

    if (bCols.includes('branch_name')) { bColsList.push('branch_name'); bValsList.push('Cabang Utama'); bPlaceholders.push(`$${bIdx++}`); }
    else if (bCols.includes('name')) { bColsList.push('name'); bValsList.push('Cabang Utama'); bPlaceholders.push(`$${bIdx++}`); }

    await pool.query(
      `INSERT INTO branches (${bColsList.join(', ')}) VALUES (${bPlaceholders.join(', ')})`,
      bValsList
    );
  }
}

// 1. INIT POS (Load Toko, Cabang, dan Produk)
app.get('/api/pos/init/:companyId', async (req, res) => {
  const { companyId } = req.params;
  try {
    await runMigration();
    await ensureCompanyAndBranch(companyId);

    const compRes = await pool.query('SELECT * FROM companies WHERE company_id::VARCHAR = $1', [companyId]);
    const branchRes = await pool.query('SELECT * FROM branches WHERE company_id::VARCHAR = $1 ORDER BY branch_id ASC', [companyId]);
    const prodRes = await pool.query(
      'SELECT * FROM products WHERE company_id::VARCHAR = $1 AND (is_active = true OR is_active IS NULL) ORDER BY product_code ASC',
      [companyId]
    );

    const comp = compRes.rows[0] || {};
    const branches = branchRes.rows.map(b => ({
      branch_id: b.branch_id,
      name: b.branch_name || b.name || b.branch_id
    }));

    const products = prodRes.rows.map(p => ({
      product_id: p.product_code || p.product_id || (p.id ? String(p.id) : p.sku),
      name: p.product_name || p.name,
      category: p.category || 'Umum',
      unit_price: Number(p.price !== undefined ? p.price : (p.unit_price || 0)),
      stock_in: Number(p.stock_in || 0),
      stock_sold: Number(p.stock_sold || 0),
      current_stock: Number(p.current_stock !== undefined ? p.current_stock : (p.stock !== undefined ? p.stock : (Number(p.stock_in || 0) - Number(p.stock_sold || 0))))
    }));

    res.json({
      success: true,
      company: {
        company_id: companyId,
        name: comp.company_name || comp.name || companyId
      },
      branches: branches,
      products: products
    });
  } catch (err) {
    console.error('POS Init Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. SYNC PRODUK DARI GOOGLE SPREADSHEET
app.post('/api/pos/sync-products', async (req, res) => {
  const { company_id, products, company_name } = req.body;
  if (!company_id || !Array.isArray(products)) {
    return res.status(400).json({ success: false, error: 'company_id and products array are required' });
  }

  try {
    await runMigration();
    await ensureCompanyAndBranch(company_id, company_name);

    const pColRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'products'`
    );
    const pCols = pColRes.rows.map(r => r.column_name.toLowerCase());

    for (const p of products) {
      const pCode = String(p.product_code || p.product_id || p.id).trim();
      const pName = String(p.product_name || p.name).trim();
      const pCat = String(p.category || 'Umum').trim();
      const pPrice = Number(p.price !== undefined ? p.price : (p.unit_price || 0));
      const sIn = Number(p.stock_in || 0);
      const sSold = Number(p.stock_sold || 0);
      let cStock = Number(p.current_stock);
      if (isNaN(cStock)) cStock = sIn - sSold;

      if (!pCode) continue;

      // Cek apakah produk sudah ada berdasarkan product_code
      const check = await pool.query(
        `SELECT * FROM products WHERE company_id::VARCHAR = $1 AND product_code = $2`,
        [company_id, pCode]
      );

      if (check.rows.length > 0) {
        // UPDATE
        const setClauses = [];
        const updateVals = [];
        let uIdx = 1;

        if (pCols.includes('product_name')) { setClauses.push(`product_name = $${uIdx++}`); updateVals.push(pName); }
        if (pCols.includes('category')) { setClauses.push(`category = $${uIdx++}`); updateVals.push(pCat); }
        if (pCols.includes('price')) { setClauses.push(`price = $${uIdx++}`); updateVals.push(pPrice); }
        if (pCols.includes('unit_price')) { setClauses.push(`unit_price = $${uIdx++}`); updateVals.push(pPrice); }
        if (pCols.includes('stock_in')) { setClauses.push(`stock_in = $${uIdx++}`); updateVals.push(sIn); }
        if (pCols.includes('stock_sold')) { setClauses.push(`stock_sold = $${uIdx++}`); updateVals.push(sSold); }
        if (pCols.includes('current_stock')) { setClauses.push(`current_stock = $${uIdx++}`); updateVals.push(cStock); }
        if (pCols.includes('stock')) { setClauses.push(`stock = $${uIdx++}`); updateVals.push(cStock); }
        if (pCols.includes('is_active')) { setClauses.push(`is_active = $${uIdx++}`); updateVals.push(true); }

        updateVals.push(company_id, pCode);
        await pool.query(
          `UPDATE products SET ${setClauses.join(', ')} WHERE company_id::VARCHAR = $${uIdx++} AND product_code = $${uIdx++}`,
          updateVals
        );
      } else {
        // INSERT
        const insertCols = ['company_id', 'product_code'];
        const insertVals = [company_id, pCode];
        const placeholders = ['$1', '$2'];
        let iIdx = 3;

        if (pCols.includes('product_name')) { insertCols.push('product_name'); insertVals.push(pName); placeholders.push(`$${iIdx++}`); }
        if (pCols.includes('category')) { insertCols.push('category'); insertVals.push(pCat); placeholders.push(`$${iIdx++}`); }
        if (pCols.includes('price')) { insertCols.push('price'); insertVals.push(pPrice); placeholders.push(`$${iIdx++}`); }
        if (pCols.includes('unit_price')) { insertCols.push('unit_price'); insertVals.push(pPrice); placeholders.push(`$${iIdx++}`); }
        if (pCols.includes('stock_in')) { insertCols.push('stock_in'); insertVals.push(sIn); placeholders.push(`$${iIdx++}`); }
        if (pCols.includes('stock_sold')) { insertCols.push('stock_sold'); insertVals.push(sSold); placeholders.push(`$${iIdx++}`); }
        if (pCols.includes('current_stock')) { insertCols.push('current_stock'); insertVals.push(cStock); placeholders.push(`$${iIdx++}`); }
        if (pCols.includes('stock')) { insertCols.push('stock'); insertVals.push(cStock); placeholders.push(`$${iIdx++}`); }
        if (pCols.includes('is_active')) { insertCols.push('is_active'); insertVals.push(true); placeholders.push(`$${iIdx++}`); }

        await pool.query(
          `INSERT INTO products (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')})`,
          insertVals
        );
      }
    }

    res.json({ success: true, count: products.length });
  } catch (err) {
    console.error('Sync Products Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. CHECKOUT TRANSAKSI KASIR
app.post('/api/pos/checkout', async (req, res) => {
  const { company_id, branch_id, cashier_name, payment_method, total_amount, items } = req.body;
  if (!company_id || !branch_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'Data transaksi tidak lengkap' });
  }

  try {
    const trxId = 'TRX-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substring(2, 5).toUpperCase();

    await pool.query(
      `INSERT INTO transactions (trx_id, company_id, branch_id, cashier_name, total_amount, payment_method, items, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [trxId, company_id, branch_id, cashier_name || 'Kasir', total_amount, payment_method || 'CASH', JSON.stringify(items)]
    );

    const pColRes = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'products'`
    );
    const pCols = pColRes.rows.map(r => r.column_name.toLowerCase());

    for (const item of items) {
      const pCode = String(item.product_id || item.product_code || item.id).trim();
      const qty = Number(item.quantity || item.qty || 1);

      const updates = [];
      const uVals = [qty];
      let idx = 2;

      if (pCols.includes('stock_sold')) updates.push(`stock_sold = COALESCE(stock_sold, 0) + $1`);
      if (pCols.includes('current_stock')) updates.push(`current_stock = GREATEST(0, COALESCE(current_stock, 0) - $1)`);
      if (pCols.includes('stock')) updates.push(`stock = GREATEST(0, COALESCE(stock, 0) - $1)`);

      if (updates.length > 0) {
        uVals.push(company_id, pCode);
        await pool.query(
          `UPDATE products SET ${updates.join(', ')} WHERE company_id::VARCHAR = $${idx++} AND product_code = $${idx++}`,
          uVals
        );
      }
    }

    res.json({ success: true, trx_id: trxId });
  } catch (err) {
    console.error('Checkout Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. PULL DATA KE GOOGLE SPREADSHEET
app.get('/api/sync/pull/:companyId', async (req, res) => {
  const { companyId } = req.params;
  try {
    const branchRes = await pool.query('SELECT * FROM branches WHERE company_id::VARCHAR = $1', [companyId]).catch(() => ({ rows: [] }));
    const branchMap = {};
    (branchRes.rows || []).forEach(b => {
      branchMap[b.branch_id] = b.branch_name || b.name || b.branch_id;
    });

    const trxRes = await pool.query(
      `SELECT trx_id, created_at, branch_id, cashier_name, total_amount, payment_method, items
       FROM transactions
       WHERE company_id::VARCHAR = $1
       ORDER BY created_at DESC`,
      [companyId]
    );

    const prodRes = await pool.query(
      `SELECT * FROM products WHERE company_id::VARCHAR = $1 ORDER BY product_code ASC`,
      [companyId]
    );

    const transactions = trxRes.rows.map(t => ({
      ...t,
      branch_name: branchMap[t.branch_id] || 'Cabang Utama'
    }));

    const products = prodRes.rows.map(p => ({
      product_code: p.product_code || p.product_id,
      product_id: p.product_code || p.product_id,
      product_name: p.product_name || p.name,
      name: p.product_name || p.name,
      stock_in: Number(p.stock_in || 0),
      stock_sold: Number(p.stock_sold || 0),
      current_stock: Number(p.current_stock !== undefined ? p.current_stock : (p.stock !== undefined ? p.stock : (Number(p.stock_in || 0) - Number(p.stock_sold || 0))))
    }));

    res.json({
      success: true,
      transactions: transactions,
      products: products
    });
  } catch (err) {
    console.error('Pull Sync Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. DASHBOARD ANALYTICS
app.get('/api/dashboard/:companyId', async (req, res) => {
  const { companyId } = req.params;
  try {
    await runMigration();
    await ensureCompanyAndBranch(companyId);

    const compRes = await pool.query('SELECT * FROM companies WHERE company_id::VARCHAR = $1', [companyId]);
    const branchRes = await pool.query('SELECT * FROM branches WHERE company_id::VARCHAR = $1', [companyId]);
    const trxRes = await pool.query(
      `SELECT trx_id, created_at, branch_id, cashier_name, total_amount, payment_method, items
       FROM transactions
       WHERE company_id::VARCHAR = $1
       ORDER BY created_at DESC`,
      [companyId]
    );
    const prodRes = await pool.query(
      `SELECT * FROM products WHERE company_id::VARCHAR = $1 ORDER BY product_code ASC`,
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

    const inventory = prodRes.rows.map(p => ({
      product_id: p.product_code || p.product_id,
      product_name: p.product_name || p.name,
      category: p.category || 'Umum',
      unit_price: Number(p.price !== undefined ? p.price : (p.unit_price || 0)),
      stock_in: Number(p.stock_in || 0),
      stock_sold: Number(p.stock_sold || 0),
      current_stock: Number(p.current_stock !== undefined ? p.current_stock : (p.stock !== undefined ? p.stock : (Number(p.stock_in || 0) - Number(p.stock_sold || 0))))
    }));

    res.json({
      success: true,
      company: {
        company_id: companyId,
        name: comp.company_name || comp.name || companyId
      },
      branches: branches,
      transactions: transactions,
      inventory: inventory
    });
  } catch (err) {
    console.error('Dashboard Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default app;
