<?php

namespace App\Presenter;

/** An order as the API returns it: everything but what clients only send. */
final class OrderPresenter
{
    /**
     * @param  array<string, mixed>  $item
     * @return array<string, mixed>
     */
    public static function one(array $item): array
    {
        $response = [];
        $response['id'] = $item['id'] ?? null;
        $response['customerId'] = $item['customerId'] ?? null;
        $response['lines'] = $item['lines'] ?? null;
        $response['status'] = $item['status'] ?? null;
        $response['total'] = $item['total'] ?? null;
        if (isset($item['notes'])) {
            $response['notes'] = $item['notes'] ?? null;
        }
        $response['createdAt'] = $item['createdAt'] ?? null;
        $response['updatedAt'] = $item['updatedAt'] ?? null;

        return $response;
    }

    /**
     * @param  list<array<string, mixed>>  $items
     * @return list<array<string, mixed>>
     */
    public static function many(array $items): array
    {
        return array_map(self::one(...), $items);
    }
}
