-- Models that only go into a table (requests, inputs, commands) and models that only come out of it (responses)
CREATE TABLE customers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email varchar(120) NOT NULL UNIQUE,
  full_name varchar(80) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(80) NOT NULL,
  price numeric(10, 2) NOT NULL
);

CREATE TABLE orders (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  status varchar(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'shipped', 'cancelled')),
  quantity integer NOT NULL,
  unit_price numeric(10, 2) NOT NULL,
  total numeric(12, 2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  shipped_at timestamp
);
