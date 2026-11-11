<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Repositories\AuthorRepository;
use App\Support\ListQuery;
use App\Support\ListResult;

/** Rules of authors: what each operation checks and changes. */
final class AuthorService
{
    /** Fields only the server writes, kept when an item is replaced */
    private const SERVER_FIELDS = ['id'];

    public function __construct(
        private readonly AuthorRepository $repository,
    ) {
    }

    /** @return array<string, mixed> */
    private function find(string $key): array
    {
        return $this->repository->get($key) ?? throw ApiException::notFound('author');
    }

    /** List authors. */
    public function listAuthors(ListQuery $query): ListResult
    {
        return $this->repository->list($query);
    }

    /** @return array<string, mixed> Get an author. */
    public function getAuthor(string $key): array
    {
        return $this->find($key);
    }

    /**
     * Create an author.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function createAuthor(array $values): array
    {
        $item = $values;

        return $this->repository->add($item);
    }

    /**
     * Replace an author: every field the client may send takes the value of the body.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function replaceAuthor(string $key, array $values): array
    {
        $current = $this->find($key);
        // What the server keeps (key, timestamps) stays; the rest is what the body says
        $item = [...array_intersect_key($current, array_flip(self::SERVER_FIELDS)), ...$values];

        return $this->repository->save($key, $item);
    }

    /**
     * Update part of an author: only the fields in the body change.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function updateAuthor(string $key, array $values): array
    {
        $current = $this->find($key);
        $item = [...$current, ...$values];

        return $this->repository->save($key, $item);
    }

    /** Delete an author. */
    public function deleteAuthor(string $key): void
    {
        $this->find($key);
        $this->repository->delete($key);
    }
}
