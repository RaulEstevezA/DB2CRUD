<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreOrderRequest;
use App\Http\Requests\UpdateOrderRequest;
use App\Http\Resources\OrderResource;
use App\Services\OrderService;
use App\Support\ListQuery;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Routes of orders: HTTP in, service calls, HTTP out. */
final class OrderController extends Controller
{
    public function __construct(private readonly OrderService $service)
    {
    }

    /** List orders. */
    public function listOrders(Request $request): Response
    {
        $query = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'size' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filters = [];
        $page = (int) ($query['page'] ?? 1);
        $size = (int) ($query['size'] ?? 20);
        $result = $this->service->listOrders(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return response()->json(['items' => OrderResource::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get an order. */
    public function getOrder(string $id): Response
    {
        $key = $this->integerKey($id, 'id');

        return response()->json(OrderResource::one($this->service->getOrder($key)), 200);
    }

    /** Create an order. */
    public function createOrder(StoreOrderRequest $request): Response
    {
        $values = $request->values();

        return response()->json(OrderResource::one($this->service->createOrder($values)), 201);
    }

    /** Replace an order. */
    public function replaceOrder(StoreOrderRequest $request, string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $values = $request->values();

        return response()->json(OrderResource::one($this->service->replaceOrder($key, $values)), 200);
    }

    /** Update part of an order. */
    public function updateOrder(UpdateOrderRequest $request, string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $values = $request->values();

        return response()->json(OrderResource::one($this->service->updateOrder($key, $values)), 200);
    }

    /** Delete an order. */
    public function deleteOrder(string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $this->service->deleteOrder($key);

        return response()->noContent(204);
    }
}
