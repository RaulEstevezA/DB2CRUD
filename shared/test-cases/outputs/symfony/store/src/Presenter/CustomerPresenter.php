<?php

namespace App\Presenter;

/** A customer as the API returns it: everything but what clients only send. */
final class CustomerPresenter
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
        $response['email'] = $item['email'] ?? null;
        if (isset($item['phone'])) {
            $response['phone'] = $item['phone'] ?? null;
        }
        $response['address'] = self::object($item['address'] ?? null);
        $response['createdAt'] = $item['createdAt'] ?? null;

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

    /** An empty array is an empty JSON object here, not a list. */
    private static function object(mixed $value): mixed
    {
        return $value === [] ? new \stdClass() : $value;
    }
}
