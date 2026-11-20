-- SQLite schema written by Model2DB from Order.
-- Review it before running it: nothing here has been run.

PRAGMA foreign_keys = ON;

CREATE TABLE customers (
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password TEXT NOT NULL,
  phone TEXT,
  created_at TEXT NOT NULL,
  address_street TEXT NOT NULL,
  address_city TEXT NOT NULL,
  address_postal_code TEXT NOT NULL,
  address_country TEXT NOT NULL,
  CONSTRAINT pk_customers PRIMARY KEY (id)
);

CREATE TABLE products (
  id INTEGER NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL,
  stock INTEGER NOT NULL,
  active INTEGER NOT NULL,
  CONSTRAINT pk_products PRIMARY KEY (id)
);

-- TODO: does the application read "Order" by customer, ordered by createdAt desc? Accept the query in the design to index it.
CREATE TABLE orders (
  id INTEGER NOT NULL,
  status TEXT NOT NULL,
  total REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  customer_id INTEGER NOT NULL,
  CONSTRAINT pk_orders PRIMARY KEY (id),
  CONSTRAINT fk_orders_customer_id FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT ck_orders_status CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled'))
);
CREATE INDEX ix_orders_customer_id ON orders (customer_id);

CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY,
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  product_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  CONSTRAINT fk_order_lines_product_id FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_order_lines_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
);
CREATE INDEX ix_order_lines_product_id ON order_lines (product_id);
CREATE INDEX ix_order_lines_order_id ON order_lines (order_id);
