<?php

namespace App\Service;

use App\Exception\ApiException;
use App\Repository\CustomerRepository;
use App\Support\ListQuery;
use App\Support\ListResult;

/** Rules of customers: what each operation checks and changes. */
final class CustomerService
{
    /** Fields only the server writes, kept when an item is replaced */
    private const SERVER_FIELDS = ['id', 'createdAt'];

    public function __construct(
        private readonly CustomerRepository $repository,
    ) {
    }

    /** @return array<string, mixed> */
    private function find(int $key): array
    {
        return $this->repository->get($key) ?? throw ApiException::notFound('customer');
    }

    /** List customers. */
    public function listCustomers(ListQuery $query): ListResult
    {
        return $this->repository->list($query);
    }

    /** @return array<string, mixed> Get a customer. */
    public function getCustomer(int $key): array
    {
        return $this->find($key);
    }

    /**
     * Create a customer.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function createCustomer(array $values): array
    {
        $item = $values;
        $now = (new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
        $item['createdAt'] = $now;

        return $this->repository->add($item);
    }

    /**
     * Replace a customer: every field the client may send takes the value of the body.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function replaceCustomer(int $key, array $values): array
    {
        $current = $this->find($key);
        // What the server keeps (key, timestamps) stays; the rest is what the body says
        $item = [...array_intersect_key($current, array_flip(self::SERVER_FIELDS)), ...$values];

        return $this->repository->save($key, $item);
    }

    /**
     * Update part of a customer: only the fields in the body change.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function updateCustomer(int $key, array $values): array
    {
        $current = $this->find($key);
        $item = [...$current, ...$values];

        return $this->repository->save($key, $item);
    }

    /** Delete a customer. */
    public function deleteCustomer(int $key): void
    {
        $this->find($key);
        $this->repository->delete($key);
    }
}
