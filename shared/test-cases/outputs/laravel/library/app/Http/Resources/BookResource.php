<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** A book as the API returns it: everything but what clients only send. */
final class BookResource extends JsonResource
{
    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        $item = $this->resource;

        return [
            'id' => $item['id'] ?? null,
            'title' => $item['title'] ?? null,
            'isbn' => $item['isbn'] ?? null,
            'authorId' => $item['authorId'] ?? null,
            'genre' => $item['genre'] ?? null,
            'pages' => $item['pages'] ?? null,
            'published' => $item['published'] ?? null,
            'available' => $item['available'] ?? null,
        ];
    }

    /**
     * @param  array<string, mixed>  $item
     * @return array<string, mixed>
     */
    public static function one(array $item): array
    {
        return (new self($item))->resolve();
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
