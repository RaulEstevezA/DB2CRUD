<?php

namespace App\Service;

use App\Exception\ApiException;
use App\Repository\AuthorRepository;
use App\Repository\BookRepository;
use App\Support\ListQuery;
use App\Support\ListResult;

/** Rules of books: what each operation checks and changes. */
final class BookService
{
    /** Fields only the server writes, kept when an item is replaced */
    private const SERVER_FIELDS = ['id'];

    public function __construct(
        private readonly BookRepository $repository,
        private readonly AuthorRepository $authorRepository,
    ) {
    }

    /** @return array<string, mixed> */
    private function find(string $key): array
    {
        return $this->repository->get($key) ?? throw ApiException::notFound('book');
    }

    /** A reference must point to a stored item. */
    private function require(object $repository, mixed $key, string $field, string $model): void
    {
        if ($key !== null && $repository->get($key) === null) {
            throw ApiException::invalid($field, "No {$model} has this key");
        }
    }

    /** @param array<string, mixed> $values */
    private function checkReferences(array $values): void
    {
        $this->require($this->authorRepository, $values['authorId'] ?? null, 'authorId', 'Author');
    }

    /** List books. */
    public function listBooks(ListQuery $query): ListResult
    {
        return $this->repository->list($query);
    }

    /** @return array<string, mixed> Get a book. */
    public function getBook(string $key): array
    {
        return $this->find($key);
    }

    /**
     * Create a book.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function createBook(array $values): array
    {
        $this->checkReferences($values);
        $item = $values;

        return $this->repository->add($item);
    }

    /**
     * Replace a book: every field the client may send takes the value of the body.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function replaceBook(string $key, array $values): array
    {
        $current = $this->find($key);
        $this->checkReferences($values);
        // What the server keeps (key, timestamps) stays; the rest is what the body says
        $item = [...array_intersect_key($current, array_flip(self::SERVER_FIELDS)), ...$values];

        return $this->repository->save($key, $item);
    }

    /**
     * Update part of a book: only the fields in the body change.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function updateBook(string $key, array $values): array
    {
        $current = $this->find($key);
        $this->checkReferences($values);
        $item = [...$current, ...$values];

        return $this->repository->save($key, $item);
    }

    /** Delete a book. */
    public function deleteBook(string $key): void
    {
        $this->find($key);
        $this->repository->delete($key);
    }
}
