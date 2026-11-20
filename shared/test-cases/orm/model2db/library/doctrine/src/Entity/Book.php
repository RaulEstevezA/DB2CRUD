<?php

namespace App\Entity;

use App\Enum\Genre;
use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/** Entity written by Model2DB from Book. Review it before using it. */
// TODO: does the application read "Book" by author, ordered by published desc? Accept the query in the design to index it.
#[ORM\Entity]
#[ORM\Table(name: 'books')]
#[ORM\Index(name: 'ix_books_author_id', columns: ['author_id'])]
class Book
{
    #[ORM\Id]
    #[ORM\Column(name: 'id', type: Types::GUID)]
    private string $id;

    #[ORM\Column(name: 'title', type: Types::STRING, length: 200)]
    private string $title;

    #[ORM\Column(name: 'isbn', type: Types::TEXT)]
    private string $isbn;

    #[ORM\Column(name: 'genre', type: Types::STRING, length: 20, enumType: Genre::class)]
    private Genre $genre;

    #[ORM\Column(name: 'pages', type: Types::INTEGER)]
    private int $pages;

    #[ORM\Column(name: 'published', type: Types::DATE_IMMUTABLE, nullable: true)]
    private ?\DateTimeImmutable $published = null;

    #[ORM\Column(name: 'available', type: Types::BOOLEAN)]
    private bool $available = true;

    #[ORM\ManyToOne(targetEntity: Author::class)]
    #[ORM\JoinColumn(name: 'author_id', referencedColumnName: 'id', nullable: false)]
    private Author $author;

    public function getId(): string
    {
        return $this->id;
    }

    public function setId(string $id): static
    {
        $this->id = $id;

        return $this;
    }

    public function getTitle(): string
    {
        return $this->title;
    }

    public function setTitle(string $title): static
    {
        $this->title = $title;

        return $this;
    }

    public function getIsbn(): string
    {
        return $this->isbn;
    }

    public function setIsbn(string $isbn): static
    {
        $this->isbn = $isbn;

        return $this;
    }

    public function getGenre(): Genre
    {
        return $this->genre;
    }

    public function setGenre(Genre $genre): static
    {
        $this->genre = $genre;

        return $this;
    }

    public function getPages(): int
    {
        return $this->pages;
    }

    public function setPages(int $pages): static
    {
        $this->pages = $pages;

        return $this;
    }

    public function getPublished(): ?\DateTimeImmutable
    {
        return $this->published;
    }

    public function setPublished(?\DateTimeImmutable $published): static
    {
        $this->published = $published;

        return $this;
    }

    public function getAvailable(): bool
    {
        return $this->available;
    }

    public function setAvailable(bool $available): static
    {
        $this->available = $available;

        return $this;
    }

    public function getAuthor(): Author
    {
        return $this->author;
    }

    public function setAuthor(Author $author): static
    {
        $this->author = $author;

        return $this;
    }
}
