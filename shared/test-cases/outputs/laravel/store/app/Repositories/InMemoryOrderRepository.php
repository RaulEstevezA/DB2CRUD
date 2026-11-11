<?php

namespace App\Repositories;

use App\Support\ListQuery;
use App\Support\ListResult;
use App\Support\Values;

/** Keeps orders in memory: they are lost when the application stops. Use it to try the API. */
final class InMemoryOrderRepository implements OrderRepository
{
    /** @var array<int|string, array<string, mixed>> */
    private array $items = [];

    private int $nextKey = 1;

    public function list(ListQuery $query): ListResult
    {
        $items = array_values(array_filter($this->items, function (array $item) use ($query): bool {
            foreach ($query->filters as $field => $value) {
                if (! Values::same($item[$field] ?? null, $value)) {
                    return false;
                }
            }

            return true;
        }));
        if ($query->sortField !== null) {
            $field = $query->sortField;
            // Items without a value go last, whatever the order
            $present = array_values(array_filter($items, fn (array $item) => ($item[$field] ?? null) !== null));
            $missing = array_values(array_filter($items, fn (array $item) => ($item[$field] ?? null) === null));
            usort($present, fn (array $a, array $b) => $query->descending
                ? Values::compare($b[$field], $a[$field])
                : Values::compare($a[$field], $b[$field]));
            $items = [...$present, ...$missing];
        }

        return new ListResult(array_slice($items, $query->offset, $query->limit), count($items));
    }

    public function get(int $key): ?array
    {
        return $this->items[$key] ?? null;
    }

    public function add(array $item): array
    {
        $item['id'] = $this->nextKey++;
        $this->items[$item['id']] = $item;

        return $item;
    }

    public function save(int $key, array $item): array
    {
        $this->items[$key] = $item;

        return $item;
    }

    public function delete(int $key): void
    {
        unset($this->items[$key]);
    }
}
