<?php

namespace App\Presenter;

/** An item as the API returns it: everything but what clients only send. */
final class ItemPresenter
{
    /**
     * @param  array<string, mixed>  $item
     * @return array<string, mixed>
     */
    public static function one(array $item): array
    {
        $response = [];
        $response['id'] = $item['id'] ?? null;
        $response['name'] = $item['name'] ?? null;
        $response['price'] = $item['price'] ?? null;
        $response['supplierEmail'] = $item['supplierEmail'] ?? null;
        $response['categoryId'] = $item['categoryId'] ?? null;
        $response['stock'] = $item['stock'] ?? null;

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
