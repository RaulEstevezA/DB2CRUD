// DbContext written by Model2DB from Book, for Npgsql.EntityFrameworkCore.PostgreSQL.
// Create the database with `dotnet ef migrations add InitialCreate` and `dotnet ef database update`.
using System.Collections.Generic;
using Microsoft.EntityFrameworkCore;

namespace Example.Data;

public class BookDbContext(DbContextOptions<BookDbContext> options) : DbContext(options)
{
    public DbSet<Author> Authors => Set<Author>();
    public DbSet<Book> Books => Set<Book>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Author>(entity =>
        {
            entity.ToTable("authors");
            entity.HasKey(e => e.Id).HasName("pk_authors");
            entity.Property(e => e.Id).HasColumnName("id").HasColumnType("UUID").IsRequired().ValueGeneratedNever();
            entity.Property(e => e.Name).HasColumnName("name").HasColumnType("VARCHAR(120)").IsRequired();
            entity.Property(e => e.Email).HasColumnName("email").HasColumnType("TEXT");
            entity.Property(e => e.Born).HasColumnName("born").HasColumnType("DATE");
        });

        modelBuilder.Entity<Book>(entity =>
        {
            entity.ToTable("books", t => { t.HasCheckConstraint("ck_books_genre", "genre IN ('novel', 'essay', 'poetry', 'science')"); });
            entity.HasKey(e => e.Id).HasName("pk_books");
            entity.Property(e => e.Id).HasColumnName("id").HasColumnType("UUID").IsRequired().ValueGeneratedNever();
            entity.Property(e => e.Title).HasColumnName("title").HasColumnType("VARCHAR(200)").IsRequired();
            entity.Property(e => e.Isbn).HasColumnName("isbn").HasColumnType("TEXT").IsRequired();
            entity.Property(e => e.Genre).HasColumnName("genre").HasColumnType("VARCHAR(20)").IsRequired().HasConversion(v => GenreValues.ToValue(v), v => GenreValues.FromValue(v));
            entity.Property(e => e.Pages).HasColumnName("pages").HasColumnType("INTEGER").IsRequired();
            entity.Property(e => e.Published).HasColumnName("published").HasColumnType("DATE");
            entity.Property(e => e.Available).HasColumnName("available").HasColumnType("BOOLEAN").IsRequired().HasDefaultValue(true);
            entity.Property(e => e.AuthorId).HasColumnName("author_id").HasColumnType("UUID").IsRequired();
            entity.HasIndex(e => new { e.AuthorId }).HasDatabaseName("ix_books_author_id");
            entity.HasOne(e => e.Author).WithMany().HasForeignKey(e => e.AuthorId).HasConstraintName("fk_books_author_id").OnDelete(DeleteBehavior.Restrict);
        });
    }
}
