
require("dotenv").config();

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Redis connection
const redis = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379"
});

redis.on("error", (err) => {
  console.error("Redis error:", err.message);
});

const STOCK_KEY = "stock:summary";
const SUMMARY_KEY = "stock:summary:totals";

// Clear cached inventory data
async function clearCache() {
  if (!redis.isReady) return;

  try {
    await redis.del([STOCK_KEY, SUMMARY_KEY]);
  } catch (err) {
    console.error("Cache clear error:", err.message);
  }
}

// Create database tables
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      product_name VARCHAR(120) NOT NULL UNIQUE,
      quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Database tables ready");
}

// Validate YYYY-MM-DD dates
function isValidDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    message: "Backend is running",
    redis: redis.isReady ? "connected" : "unavailable"
  });
});

// Get products
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, product_name, quantity, date
      FROM products
      ORDER BY product_name
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Products error:", err.message);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// Get stock details
app.get("/api/stock-details", async (req, res) => {
  try {
    if (redis.isReady) {
      const cached = await redis.get(STOCK_KEY);

      if (cached !== null) {
        return res.json(JSON.parse(cached));
      }
    }

    const result = await pool.query(`
      SELECT
        p.id,
        p.product_name,
        (p.quantity + COALESCE(SUM(s.quantity), 0))::int AS total,
        COALESCE(SUM(s.quantity), 0)::int AS sold,
        p.quantity::int AS "left"
      FROM products p
      LEFT JOIN sales s ON s.product_id = p.id
      GROUP BY p.id, p.product_name, p.quantity
      ORDER BY p.product_name
    `);

    if (redis.isReady) {
      await redis.set(STOCK_KEY, JSON.stringify(result.rows), {
        EX: 60
      });
    }

    res.json(result.rows);
  } catch (err) {
    console.error("Stock details error:", err.message);
    res.status(500).json({ error: "Failed to fetch stock details" });
  }
});

// Get summary: total added, sold and remaining
app.get("/api/stock-summary", async (req, res) => {
  try {
    if (redis.isReady) {
      const cached = await redis.get(SUMMARY_KEY);

      if (cached !== null) {
        return res.json(JSON.parse(cached));
      }
    }

    const result = await pool.query(`
      SELECT
        (
          COALESCE((SELECT SUM(quantity) FROM products), 0) +
          COALESCE((SELECT SUM(quantity) FROM sales), 0)
        )::int AS total_added,
        COALESCE((SELECT SUM(quantity) FROM sales), 0)::int AS total_sold,
        COALESCE((SELECT SUM(quantity) FROM products), 0)::int AS remaining
    `);

    const summary = result.rows[0];

    if (redis.isReady) {
      await redis.set(SUMMARY_KEY, JSON.stringify(summary), {
        EX: 60
      });
    }

    res.json(summary);
  } catch (err) {
    console.error("Summary error:", err.message);
    res.status(500).json({ error: "Failed to fetch summary" });
  }
});

// Add product or update available quantity
app.post("/api/products", async (req, res) => {
  const { product_name, quantity, date } = req.body;

  const name =
    typeof product_name === "string" ? product_name.trim() : "";

  const amount = Number(quantity);

  if (
    !name ||
    name.length > 120 ||
    !Number.isInteger(amount) ||
    amount < 1 ||
    !isValidDate(date)
  ) {
    return res.status(400).json({
      error: "Enter a valid product name, quantity, and date"
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO products (product_name, quantity, date)
       VALUES ($1, $2, $3)
       ON CONFLICT (product_name)
       DO UPDATE SET
         quantity = EXCLUDED.quantity,
         date = EXCLUDED.date
       RETURNING id, product_name, quantity, date`,
      [name, amount, date]
    );

    await clearCache();

    res.status(201).json({
      message: "Product saved successfully",
      product: result.rows[0]
    });
  } catch (err) {
    console.error("Save product error:", err.message);
    res.status(500).json({ error: "Failed to save product" });
  }
});

// Record sale and decrease stock
app.post("/api/sales", async (req, res) => {
  const { product_id, quantity, date } = req.body;

  const productId = Number(product_id);
  const soldQuantity = Number(quantity);

  if (
    !Number.isInteger(productId) ||
    productId < 1 ||
    !Number.isInteger(soldQuantity) ||
    soldQuantity < 1 ||
    !isValidDate(date)
  ) {
    return res.status(400).json({
      error: "Enter a valid product, quantity, and sale date"
    });
  }

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    const productResult = await client.query(
      `SELECT id, product_name, quantity
       FROM products
       WHERE id = $1
       FOR UPDATE`,
      [productId]
    );

    if (productResult.rows.length === 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return res.status(404).json({ error: "Product not found" });
    }

    const product = productResult.rows[0];

    if (product.quantity < soldQuantity) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(400).json({
        error: `Insufficient stock. Available: ${product.quantity}`
      });
    }

    const saleResult = await client.query(
      `INSERT INTO sales (product_id, quantity, date)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [productId, soldQuantity, date]
    );

    const updatedProduct = await client.query(
      `UPDATE products
       SET quantity = quantity - $1
       WHERE id = $2
       RETURNING id, product_name, quantity, date`,
      [soldQuantity, productId]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    await clearCache();

    res.status(201).json({
      message: "Sale recorded successfully",
      sale: saleResult.rows[0],
      product: updatedProduct.rows[0]
    });
  } catch (err) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("Sale error:", err.message);

    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to record sale" });
    }
  } finally {
    if (client) client.release();
  }
});

// Get sales history
app.get("/api/sales", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.id,
        s.product_id,
        p.product_name,
        s.quantity,
        s.date
      FROM sales s
      JOIN products p ON p.id = s.product_id
      ORDER BY s.id DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Sales history error:", err.message);
    res.status(500).json({ error: "Failed to fetch sales" });
  }
});

// Clear all inventory data
app.delete("/api/inventory", async (req, res) => {
  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    await client.query(
      "TRUNCATE TABLE sales, products RESTART IDENTITY CASCADE"
    );

    await client.query("COMMIT");
    transactionStarted = false;

    await clearCache();

    res.json({
      message: "All inventory data cleared successfully",
      total_added: 0,
      total_sold: 0,
      remaining: 0
    });
  } catch (err) {
    if (client && transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }

    console.error("Clear inventory error:", err.message);

    res.status(500).json({ error: "Could not clear inventory" });
  } finally {
    if (client) client.release();
  }
});

// Start server
async function startServer() {
  try {
    await pool.query("SELECT 1");
    console.log("PostgreSQL connected successfully");

    await initializeDatabase();

    try {
      if (!redis.isOpen) {
        await redis.connect();
      }

      console.log("Redis connected successfully");
    } catch (err) {
      console.error("Redis unavailable:", err.message);
    }

    app.listen(PORT,"0.0.0.0", () => {
      console.log(`Server running at http://localhost:${PORT}`);
      console.log(`Health: http://localhost:${PORT}/api/health`);
    });
  } catch (err) {
    console.error("Server startup failed:", err.message);
    await pool.end();
    process.exit(1);
  }
}

startServer();