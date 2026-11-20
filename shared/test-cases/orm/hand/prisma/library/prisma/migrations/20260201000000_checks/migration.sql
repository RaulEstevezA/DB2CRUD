-- Checks Prisma does not write: added by hand
ALTER TABLE "lending"."copies" DROP CONSTRAINT "ck_copies_number";
ALTER TABLE "lending"."copies" ADD CONSTRAINT "ck_copies_number" CHECK ("number" >= 1);
ALTER TABLE ONLY "public"."authors" ADD CONSTRAINT "ck_authors_name" CHECK (length(name) > 0);
ALTER TABLE "lending"."loans" ADD CHECK (returned_at IS NULL OR returned_at >= lent_at);
