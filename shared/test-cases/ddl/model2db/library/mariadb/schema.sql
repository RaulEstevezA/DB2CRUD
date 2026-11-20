-- MariaDB schema written by Model2DB from Book.
-- Review it before running it: nothing here has been run.

CREATE TABLE authors (
  id UUID NOT NULL,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255),
  born DATE,
  CONSTRAINT pk_authors PRIMARY KEY (id)
);

-- TODO: does the application read "Book" by author, ordered by published desc? Accept the query in the design to index it.
CREATE TABLE books (
  id UUID NOT NULL,
  title VARCHAR(200) NOT NULL,
  isbn VARCHAR(255) NOT NULL,
  genre VARCHAR(20) NOT NULL,
  pages INT NOT NULL,
  published DATE,
  available BOOLEAN DEFAULT TRUE NOT NULL,
  author_id UUID NOT NULL,
  CONSTRAINT pk_books PRIMARY KEY (id),
  CONSTRAINT fk_books_author_id FOREIGN KEY (author_id) REFERENCES authors (id),
  CONSTRAINT ck_books_genre CHECK (genre IN ('novel', 'essay', 'poetry', 'science'))
);
CREATE INDEX ix_books_author_id ON books (author_id);
