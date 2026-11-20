-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "lending";

-- CreateEnum
CREATE TYPE "public"."book_format" AS ENUM ('hardcover', 'paperback', 'e-book');

-- CreateTable
CREATE TABLE "public"."authors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    CONSTRAINT "authors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."books" (
    "isbn" CHAR(13) NOT NULL,
    "title" TEXT NOT NULL,
    "pages" SMALLINT CHECK ("pages" > 0),
    "price" DECIMAL(8,2) NOT NULL DEFAULT 0,
    CONSTRAINT "books_pkey" PRIMARY KEY ("isbn"),
    CONSTRAINT "ck_books_price" CHECK (price >= 0)
);

-- CreateTable
CREATE TABLE "lending"."copies" (
    "book_isbn" CHAR(13) NOT NULL,
    "number" INTEGER NOT NULL,
    CONSTRAINT "pk_copies" PRIMARY KEY ("book_isbn", "number"),
    CONSTRAINT "ck_copies_number" CHECK ("number" BETWEEN 1 AND 99)
);

-- CreateTable
CREATE TABLE "lending"."loans" (
    "id" BIGSERIAL NOT NULL,
    "lent_at" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "returned_at" TIMESTAMP(3),
    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);
