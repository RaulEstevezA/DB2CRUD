<?php

namespace App\Presenter;

/** A product as the API returns it: everything but what clients only send. */
final class ProductPresenter
{
    /**
     * @param  array<string, mixed>  $item
     * @return array<string, mixed>
     */
    public static function one(array $item): array
    {
        $response = [];
        $response['id'] = $item['id'] ?? null;
        $response['sku'] = $item['sku'] ?? null;
        $response['name'] = $item['name'] ?? null;
        if (isset($item['description'])) {
            $response['description'] = $item['description'] ?? null;
        }
        $response['price'] = $item['price'] ?? null;
        $response['stock'] = $item['stock'] ?? null;
        $response['active'] = $item['active'] ?? null;

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
