<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreItemRequest;
use App\Http\Requests\UpdateItemRequest;
use App\Http\Resources\ItemResource;
use App\Services\ItemService;
use App\Support\ListQuery;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Routes of items: HTTP in, service calls, HTTP out. */
final class ItemController extends Controller
{
    public function __construct(private readonly ItemService $service)
    {
    }

    /** List items. */
    public function listItems(Request $request): Response
    {
        $query = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'size' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filters = [];
        $page = (int) ($query['page'] ?? 1);
        $size = (int) ($query['size'] ?? 20);
        $result = $this->service->listItems(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return response()->json(['items' => ItemResource::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get an item. */
    public function getItem(string $id): Response
    {
        $key = $this->integerKey($id, 'id');

        return response()->json(ItemResource::one($this->service->getItem($key)), 200);
    }

    /** Create an item. */
    public function createItem(StoreItemRequest $request): Response
    {
        $values = $request->values();

        return response()->json(ItemResource::one($this->service->createItem($values)), 201);
    }

    /** Replace an item. */
    public function replaceItem(StoreItemRequest $request, string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $values = $request->values();

        return response()->json(ItemResource::one($this->service->replaceItem($key, $values)), 200);
    }

    /** Update part of an item. */
    public function updateItem(UpdateItemRequest $request, string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $values = $request->values();

        return response()->json(ItemResource::one($this->service->updateItem($key, $values)), 200);
    }

    /** Delete an item. */
    public function deleteItem(string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $this->service->deleteItem($key);

        return response()->noContent(204);
    }
}
