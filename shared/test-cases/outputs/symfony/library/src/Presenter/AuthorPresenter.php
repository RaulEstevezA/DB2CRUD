<?php

namespace App\Presenter;

/** An author as the API returns it: everything but what clients only send. */
final class AuthorPresenter
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
        $response['born'] = $item['born'] ?? null;

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
