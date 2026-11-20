-- MariaDB schema written by Model2DB from Order.
-- Review it before running it: nothing here has been run.

CREATE TABLE customers (
  id BIGINT NOT NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password VARCHAR(255) NOT NULL,
  phone VARCHAR(255),
  created_at DATETIME(6) NOT NULL,
  address_street VARCHAR(255) NOT NULL,
  address_city VARCHAR(255) NOT NULL,
  address_postal_code VARCHAR(255) NOT NULL,
  address_country VARCHAR(255) NOT NULL,
  CONSTRAINT pk_customers PRIMARY KEY (id)
);

CREATE TABLE products (
  id BIGINT NOT NULL,
  sku VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(255),
  price DOUBLE NOT NULL,
  stock INT NOT NULL,
  active BOOLEAN NOT NULL,
  CONSTRAINT pk_products PRIMARY KEY (id)
);

-- TODO: does the application read "Order" by customer, ordered by createdAt desc? Accept the query in the design to index it.
CREATE TABLE orders (
  id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL,
  total DOUBLE NOT NULL,
  notes VARCHAR(255),
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  customer_id BIGINT NOT NULL,
  CONSTRAINT pk_orders PRIMARY KEY (id),
  CONSTRAINT fk_orders_customer_id FOREIGN KEY (customer_id) REFERENCES customers (id),
  CONSTRAINT ck_orders_status CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled'))
);
CREATE INDEX ix_orders_customer_id ON orders (customer_id);

CREATE TABLE order_lines (
  id BIGINT AUTO_INCREMENT NOT NULL,
  quantity INT NOT NULL,
  unit_price DOUBLE NOT NULL,
  product_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  CONSTRAINT pk_order_lines PRIMARY KEY (id),
  CONSTRAINT fk_order_lines_product_id FOREIGN KEY (product_id) REFERENCES products (id),
  CONSTRAINT fk_order_lines_order_id FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE
);
CREATE INDEX ix_order_lines_product_id ON order_lines (product_id);
CREATE INDEX ix_order_lines_order_id ON order_lines (order_id);
