CREATE TABLE things (
  id integer PRIMARY KEY AUTOINCREMENT,
  small smallint NOT NULL,
  big bigint NOT NULL,
  price numeric(10,2) NOT NULL,
  d real NOT NULL,
  flag boolean NOT NULL DEFAULT 1,
  born date NOT NULL,
  opens time NOT NULL,
  at datetime NOT NULL,
  changed timestamp DEFAULT CURRENT_TIMESTAMP,
  bin blob NOT NULL,
  data json,
  code char(5) NOT NULL,
  note text,
  total numeric(12,2) GENERATED ALWAYS AS (price * 2) STORED
);
CREATE TABLE kinds (
  code varchar(10) NOT NULL,
  day date NOT NULL,
  label varchar(30),
  PRIMARY KEY (code, day)
);
CREATE TABLE "Order" (
  "Id" integer PRIMARY KEY,
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
  "createdAt" datetime DEFAULT CURRENT_TIMESTAMP,
  kind_code varchar(10),
  kind_day date,
  thing_id integer REFERENCES things (id) ON DELETE SET NULL,
  "parentId" integer REFERENCES "Order" ("Id"),
  FOREIGN KEY (kind_code, kind_day) REFERENCES kinds (code, day)
);
CREATE TABLE audit_entries (
  entry_no integer PRIMARY KEY,
  "orderId" integer NOT NULL REFERENCES "Order" ("Id") ON DELETE CASCADE,
  message varchar(200) NOT NULL
);
CREATE TABLE empties (
  id integer PRIMARY KEY,
  note text
);
