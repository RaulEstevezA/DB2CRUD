<?php

namespace App\Presenter;

/** A book as the API returns it: everything but what clients only send. */
final class BookPresenter
{
    /**
     * @param  array<string, mixed>  $item
     * @return array<string, mixed>
     */
    public static function one(array $item): array
    {
        $response = [];
        $response['id'] = $item['id'] ?? null;
        $response['title'] = $item['title'] ?? null;
        $response['isbn'] = $item['isbn'] ?? null;
        $response['authorId'] = $item['authorId'] ?? null;
        $response['genre'] = $item['genre'] ?? null;
        $response['pages'] = $item['pages'] ?? null;
        $response['published'] = $item['published'] ?? null;
        $response['available'] = $item['available'] ?? null;

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
