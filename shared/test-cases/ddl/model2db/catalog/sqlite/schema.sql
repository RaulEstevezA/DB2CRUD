-- SQLite schema written by Model2DB from Item.
-- Review it before running it: nothing here has been run.

PRAGMA foreign_keys = ON;

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER NOT NULL,
  CONSTRAINT fk_categories_parent_id FOREIGN KEY (parent_id) REFERENCES categories (id)
);
CREATE INDEX ix_categories_parent_id ON categories (parent_id);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price NUMERIC NOT NULL,
  supplier_email TEXT NOT NULL,
  stock INTEGER NOT NULL,
  category_id INTEGER NOT NULL,
  CONSTRAINT fk_items_category_id FOREIGN KEY (category_id) REFERENCES categories (id)
);
CREATE INDEX ix_items_category_id ON items (category_id);
