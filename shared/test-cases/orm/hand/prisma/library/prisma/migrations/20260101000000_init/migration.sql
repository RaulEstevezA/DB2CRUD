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
    CONSTRAINT "ck_copies_number" CHECK ("number" BETWEEN 1 AND 99)
);
