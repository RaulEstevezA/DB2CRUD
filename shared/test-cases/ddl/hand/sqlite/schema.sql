PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS "authors" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" TEXT NOT NULL COLLATE NOCASE,
  "email" TEXT UNIQUE,
  "born" DATE,
  "score" REAL DEFAULT 0.5,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "joined" TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE books (
  isbn TEXT NOT NULL PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES authors ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL CHECK (length(title) > 0),
  pages INTEGER CONSTRAINT ck_books_pages CHECK (pages > 0),
  cover BLOB,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live')),
  words INTEGER,
  minutes INTEGER GENERATED ALWAYS AS (words / 200) STORED
) WITHOUT ROWID;

CREATE TABLE loans (
  book_isbn TEXT NOT NULL,
  reader TEXT NOT NULL,
  since TEXT NOT NULL,
  PRIMARY KEY (book_isbn, reader),
  FOREIGN KEY (book_isbn) REFERENCES books (isbn)
);

CREATE INDEX ix_books_author ON books (author_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_loans_since ON loans (book_isbn, since DESC);
CREATE INDEX ix_books_lower ON books (lower(title));

CREATE TRIGGER books_touch AFTER UPDATE ON books BEGIN
  UPDATE books SET words = words WHERE isbn = NEW.isbn;
END;

CREATE VIEW live_books AS SELECT * FROM books WHERE status = 'live';
