CREATE TABLE customers (
  id BIGSERIAL PRIMARY KEY,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(60) NOT NULL UNIQUE
);
CREATE TABLE products (
  id BIGSERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories (id),
  name VARCHAR(100) NOT NULL,
  price NUMERIC(10, 2) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live'))
);
CREATE TABLE tags (
  id SERIAL PRIMARY KEY,
  label VARCHAR(30) NOT NULL
);
CREATE TABLE product_tags (
  product_id BIGINT NOT NULL REFERENCES products (id),
  tag_id INTEGER NOT NULL REFERENCES tags (id),
  PRIMARY KEY (product_id, tag_id)
);
