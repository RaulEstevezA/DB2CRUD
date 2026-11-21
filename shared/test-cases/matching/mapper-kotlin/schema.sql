-- A Mapper project whose target is the model of the table: it says how a form of the application is written
CREATE TABLE customers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email varchar(120) NOT NULL UNIQUE,
  full_name varchar(120) NOT NULL,
  status varchar(10) NOT NULL CHECK (status IN ('active', 'blocked')),
  created_at timestamp NOT NULL,
  balance_cents integer NOT NULL,
  nickname varchar(40),
  country char(2) NOT NULL
);
