<?php

namespace App\Services;

use App\Exceptions\ApiException;
use App\Repositories\CustomerRepository;
use App\Repositories\OrderRepository;
use App\Repositories\ProductRepository;
use App\Support\ListQuery;
use App\Support\ListResult;

/** Rules of orders: what each operation checks and changes. */
final class OrderService
{
    /** Fields only the server writes, kept when an item is replaced */
    private const SERVER_FIELDS = ['id', 'createdAt', 'updatedAt'];

    public function __construct(
        private readonly OrderRepository $repository,
        private readonly CustomerRepository $customerRepository,
        private readonly ProductRepository $productRepository,
    ) {
    }

    /** @return array<string, mixed> */
    private function find(int $key): array
    {
        return $this->repository->get($key) ?? throw ApiException::notFound('order');
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
        $this->require($this->customerRepository, $values['customerId'] ?? null, 'customerId', 'Customer');
        foreach ($values['lines'] ?? [] as $item0) {
            $this->require($this->productRepository, $item0['productId'] ?? null, 'lines.productId', 'Product');
        }
    }

    /** List orders. */
    public function listOrders(ListQuery $query): ListResult
    {
        return $this->repository->list($query);
    }

    /** @return array<string, mixed> Get an order. */
    public function getOrder(int $key): array
    {
        return $this->find($key);
    }

    /**
     * Create an order.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function createOrder(array $values): array
    {
        $this->checkReferences($values);
        $item = $values;
        $now = now()->utc()->format('Y-m-d\TH:i:s.v\Z');
        $item['createdAt'] = $now;
        $item['updatedAt'] = $now;

        return $this->repository->add($item);
    }

    /**
     * Replace an order: every field the client may send takes the value of the body.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function replaceOrder(int $key, array $values): array
    {
        $current = $this->find($key);
        $this->checkReferences($values);
        // What the server keeps (key, timestamps) stays; the rest is what the body says
        $item = [...array_intersect_key($current, array_flip(self::SERVER_FIELDS)), ...$values];
        $now = now()->utc()->format('Y-m-d\TH:i:s.v\Z');
        $item['updatedAt'] = $now;

        return $this->repository->save($key, $item);
    }

    /**
     * Update part of an order: only the fields in the body change.
     *
     * @param  array<string, mixed>  $values
     * @return array<string, mixed>
     */
    public function updateOrder(int $key, array $values): array
    {
        $current = $this->find($key);
        $this->checkReferences($values);
        $item = [...$current, ...$values];
        $now = now()->utc()->format('Y-m-d\TH:i:s.v\Z');
        $item['updatedAt'] = $now;

        return $this->repository->save($key, $item);
    }

    /** Delete an order. */
    public function deleteOrder(int $key): void
    {
        $this->find($key);
        $this->repository->delete($key);
    }
}
