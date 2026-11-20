<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/** Migration written by Model2DB from Item: the schema as Model2DB writes it for this engine. */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE TABLE categories (
              id BIGINT AUTO_INCREMENT NOT NULL,
              name VARCHAR(80) NOT NULL,
              parent_id BIGINT NOT NULL,
              CONSTRAINT pk_categories PRIMARY KEY (id),
              CONSTRAINT fk_categories_parent_id FOREIGN KEY (parent_id) REFERENCES categories (id)
            )
            SQL);
        DB::statement(<<<'SQL'
            CREATE INDEX ix_categories_parent_id ON categories (parent_id)
            SQL);
        DB::statement(<<<'SQL'
            CREATE TABLE items (
              id BIGINT AUTO_INCREMENT NOT NULL,
              name VARCHAR(120) NOT NULL,
              price DECIMAL(18, 2) NOT NULL,
              supplier_email VARCHAR(255) NOT NULL,
              stock INT NOT NULL,
              category_id BIGINT NOT NULL,
              CONSTRAINT pk_items PRIMARY KEY (id),
              CONSTRAINT fk_items_category_id FOREIGN KEY (category_id) REFERENCES categories (id)
            )
            SQL);
        DB::statement(<<<'SQL'
            CREATE INDEX ix_items_category_id ON items (category_id)
            SQL);
    }

    public function down(): void
    {
        DB::statement('DROP TABLE items');
        DB::statement('DROP TABLE categories');
    }
};
