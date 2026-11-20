-- A Mapper project whose source is the model of the table: it says how a row is read into a summary
CREATE TABLE orders (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id integer NOT NULL,
  total_cents integer NOT NULL,
  placed_at timestamp NOT NULL DEFAULT now(),
  note text
);
