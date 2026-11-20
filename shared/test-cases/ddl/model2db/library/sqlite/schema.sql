-- SQLite schema written by Model2DB from Book.
-- Review it before running it: nothing here has been run.

PRAGMA foreign_keys = ON;

CREATE TABLE authors (
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  born TEXT,
  CONSTRAINT pk_authors PRIMARY KEY (id)
);

-- TODO: does the application read "Book" by author, ordered by published desc? Accept the query in the design to index it.
CREATE TABLE books (
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  isbn TEXT NOT NULL,
  genre TEXT NOT NULL,
  pages INTEGER NOT NULL,
  published TEXT,
  available INTEGER DEFAULT 1 NOT NULL,
  author_id TEXT NOT NULL,
  CONSTRAINT pk_books PRIMARY KEY (id),
  CONSTRAINT fk_books_author_id FOREIGN KEY (author_id) REFERENCES authors (id),
  CONSTRAINT ck_books_genre CHECK (genre IN ('novel', 'essay', 'poetry', 'science'))
);
CREATE INDEX ix_books_author_id ON books (author_id);
