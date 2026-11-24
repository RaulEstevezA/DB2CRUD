CREATE SCHEMA audit;
CREATE TYPE mood AS ENUM ('sad', 'ok', 'very happy');
CREATE TABLE things (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token uuid NOT NULL,
  small smallint NOT NULL,
  num integer,
  big bigint NOT NULL,
  price numeric(10,2) NOT NULL,
  r real NOT NULL,
  d double precision,
  flag boolean NOT NULL DEFAULT true,
  born date NOT NULL,
  opens time NOT NULL,
  opens_tz time with time zone NOT NULL,
  at timestamp NOT NULL,
  at_tz timestamptz NOT NULL,
  bin bytea NOT NULL,
  data jsonb NOT NULL,
  plain json,
  feeling mood NOT NULL,
  tags text[] NOT NULL,
  numbers integer[],
  ip inet,
  span interval,
  code char(5) NOT NULL,
  note text,
  changed timestamptz DEFAULT now(),
  total numeric(12,2) GENERATED ALWAYS AS (price * 2) STORED
);
CREATE TABLE kinds (
  code varchar(10) NOT NULL,
  day date NOT NULL,
  label varchar(30),
  PRIMARY KEY (code, day)
);
CREATE TABLE "Order" (
  "Id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "user" varchar(40) NOT NULL,
  "group" integer NOT NULL DEFAULT 0 CHECK ("group" >= 0),
  "customerName" varchar(60) NOT NULL UNIQUE,
  "class" text,
  "metadata" text,
  "date" date,
  "time" time,
  "text" varchar(20),
  "list" text,
  "str" varchar(10),
  "int" integer,
  "dueDate" date NOT NULL,
  "closesAt" time,
  "createdAt" timestamp DEFAULT CURRENT_TIMESTAMP,
  kind_code varchar(10),
  kind_day date,
  thing_id uuid REFERENCES things (id) ON DELETE SET NULL,
  "parentId" bigint REFERENCES "Order" ("Id"),
  FOREIGN KEY (kind_code, kind_day) REFERENCES kinds (code, day)
);
CREATE TABLE audit.entries (
  entry_no serial PRIMARY KEY,
  "orderId" bigint NOT NULL REFERENCES "Order" ("Id") ON DELETE CASCADE,
  message varchar(200) NOT NULL
);
CREATE TABLE empties (
  id bigserial PRIMARY KEY,
  note text
);
