<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/** Migration written by Model2DB from Book: the schema as Model2DB writes it for this engine. */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE TABLE authors (
              id UUID NOT NULL,
              name VARCHAR(120) NOT NULL,
              email TEXT,
              born DATE,
              CONSTRAINT pk_authors PRIMARY KEY (id)
            )
            SQL);
        DB::statement(<<<'SQL'
            CREATE TABLE books (
              id UUID NOT NULL,
              title VARCHAR(200) NOT NULL,
              isbn TEXT NOT NULL,
              genre VARCHAR(20) NOT NULL,
              pages INTEGER NOT NULL,
              published DATE,
              available BOOLEAN DEFAULT TRUE NOT NULL,
              author_id UUID NOT NULL,
              CONSTRAINT pk_books PRIMARY KEY (id),
              CONSTRAINT fk_books_author_id FOREIGN KEY (author_id) REFERENCES authors (id),
              CONSTRAINT ck_books_genre CHECK (genre IN ('novel', 'essay', 'poetry', 'science'))
            )
            SQL);
        DB::statement(<<<'SQL'
            CREATE INDEX ix_books_author_id ON books (author_id)
            SQL);
    }

    public function down(): void
    {
        DB::statement('DROP TABLE books');
        DB::statement('DROP TABLE authors');
    }
};
