// DbContext written by Model2DB from Item, for Pomelo.EntityFrameworkCore.MySql.
// Create the database with `dotnet ef migrations add InitialCreate` and `dotnet ef database update`.
using System.Collections.Generic;
using Microsoft.EntityFrameworkCore;

namespace Example.Data;

public class ItemDbContext(DbContextOptions<ItemDbContext> options) : DbContext(options)
{
    public DbSet<Category> Categories => Set<Category>();
    public DbSet<Item> Items => Set<Item>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Category>(entity =>
        {
            entity.ToTable("categories");
            entity.HasKey(e => e.Id).HasName("pk_categories");
            entity.Property(e => e.Id).HasColumnName("id").HasColumnType("BIGINT").IsRequired().ValueGeneratedOnAdd();
            entity.Property(e => e.Name).HasColumnName("name").HasColumnType("VARCHAR(80)").IsRequired();
            entity.Property(e => e.ParentId).HasColumnName("parent_id").HasColumnType("BIGINT").IsRequired();
            entity.HasIndex(e => new { e.ParentId }).HasDatabaseName("ix_categories_parent_id");
            entity.HasOne(e => e.Parent).WithMany().HasForeignKey(e => e.ParentId).HasConstraintName("fk_categories_parent_id").OnDelete(DeleteBehavior.Restrict);
        });

        modelBuilder.Entity<Item>(entity =>
        {
            entity.ToTable("items");
            entity.HasKey(e => e.Id).HasName("pk_items");
            entity.Property(e => e.Id).HasColumnName("id").HasColumnType("BIGINT").IsRequired().ValueGeneratedOnAdd();
            entity.Property(e => e.Name).HasColumnName("name").HasColumnType("VARCHAR(120)").IsRequired();
            entity.Property(e => e.Price).HasColumnName("price").HasColumnType("DECIMAL(18, 2)").IsRequired();
            entity.Property(e => e.SupplierEmail).HasColumnName("supplier_email").HasColumnType("VARCHAR(255)").IsRequired();
            entity.Property(e => e.Stock).HasColumnName("stock").HasColumnType("INT").IsRequired();
            entity.Property(e => e.CategoryId).HasColumnName("category_id").HasColumnType("BIGINT").IsRequired();
            entity.HasIndex(e => new { e.CategoryId }).HasDatabaseName("ix_items_category_id");
            entity.HasOne(e => e.Category).WithMany().HasForeignKey(e => e.CategoryId).HasConstraintName("fk_items_category_id").OnDelete(DeleteBehavior.Restrict);
        });
    }
}
