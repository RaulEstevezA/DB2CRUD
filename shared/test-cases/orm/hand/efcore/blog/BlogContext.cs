using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Blog.Data
{
    public enum PostState { Draft, Published = 5, Archived }

    public abstract class Entity
    {
        public DateTime CreatedAt { get; set; }
    }

    [Index(nameof(Url), IsUnique = true, Name = "ix_blogs_url")]
    public class Blog : Entity
    {
        public int Id { get; set; }

        [Required, MaxLength(200)]
        public string Url { get; set; } = "";

        public string? Title { get; set; }

        [Column("rating", TypeName = "decimal(3, 1)")]
        public decimal? Rating { get; set; }

        [NotMapped]
        public string Display => Url;

        public int PostCount { get; }

        public List<Post> Posts { get; set; } = new();
        public BlogImage? Image { get; set; }
    }

    [Table("post_entries", Schema = "content")]
    public class Post
    {
        [Key]
        public Guid Key { get; set; }

        [StringLength(120)]
        public string Heading { get; set; } = null!;

        public PostState State { get; set; }
        public PostState? Previous { get; set; }

        [DatabaseGenerated(DatabaseGeneratedOption.None)]
        public long Number { get; set; }

        public int BlogId { get; set; }
        public Blog Blog { get; set; } = null!;

        public ICollection<Tag> Tags { get; set; } = new HashSet<Tag>();

        public Author? Author { get; set; }

        public int Words { get; set; }
        public int Minutes { get; set; }
    }

    public class BlogImage
    {
        public int Id { get; set; }
        public byte[] Data { get; set; } = [];
        public int BlogForeignKey { get; set; }
    }

    public class Tag
    {
        public string TagId { get; set; } = null!;
        public List<Post> Posts { get; set; } = [];
    }

    public class Author
    {
        public int AuthorId { get; set; }
        public string Name { get; set; } = "";
    }

    [Keyless]
    public class PageView
    {
        public string Path { get; set; } = "";
        public DateTimeOffset At { get; set; }
    }

    public class BlogContext(DbContextOptions<BlogContext> options) : DbContext(options)
    {
        public DbSet<Blog> Blogs => Set<Blog>();
        public DbSet<Post> Posts { get; set; } = null!;
        public DbSet<Tag> Tags => Set<Tag>();
        public DbSet<Author> Authors => Set<Author>();
        public DbSet<PageView> PageViews => Set<PageView>();

        protected override void OnConfiguring(DbContextOptionsBuilder options) => options.UseSqlServer("Server=.;Database=blog");

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.ApplyConfiguration(new PostConfiguration());

            modelBuilder.Entity<Blog>()
                .HasOne(b => b.Image)
                .WithOne()
                .HasForeignKey<BlogImage>(i => i.BlogForeignKey);

            modelBuilder.Entity<Blog>().Property(b => b.CreatedAt).HasDefaultValueSql("getutcdate()");

            modelBuilder.Entity<BlogImage>(b => b.ToTable("BlogImages", t => t.HasComment("Pictures")));
        }
    }

    public class PostConfiguration : IEntityTypeConfiguration<Post>
    {
        public void Configure(EntityTypeBuilder<Post> builder)
        {
            builder.Property(p => p.State).HasConversion<string>().HasMaxLength(12).HasDefaultValue(PostState.Draft);
            builder.Property(p => p.Minutes).HasComputedColumnSql("[Words] / 200", stored: true);
            builder.HasIndex(p => new { p.BlogId, p.Heading }).HasDatabaseName("ix_posts_blog_heading");
            builder.HasMany(p => p.Tags).WithMany(t => t.Posts).UsingEntity("post_tags");
            builder.ToTable(tb => tb.HasCheckConstraint("CK_Words", "[Words] >= 0"));
        }
    }
}
