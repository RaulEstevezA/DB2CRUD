<?php

namespace App\Controller;

use App\Http\JsonBody;
use App\Input\OrderInput;
use App\Presenter\OrderPresenter;
use App\Service\OrderService;
use App\Support\ListQuery;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Routing\Attribute\Route;

/** Routes of orders: HTTP in, service calls, HTTP out. */
#[AsController]
final class OrderController extends ApiController
{
    public function __construct(
        private readonly OrderService $service,
        private readonly JsonBody $body,
    ) {
    }

    /** List orders. */
    #[Route('/orders', name: 'listOrders', methods: ['GET'])]
    public function listOrders(Request $request): Response
    {
        $page = $this->integerQuery($request, 'page', 1, 1);
        $size = $this->integerQuery($request, 'size', 20, 1, 100);
        $filters = [];
        $result = $this->service->listOrders(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return $this->answer(['items' => OrderPresenter::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get an order. */
    #[Route('/orders/{id}', name: 'getOrder', methods: ['GET'])]
    public function getOrder(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');

        return $this->answer(OrderPresenter::one($this->service->getOrder($key)), 200);
    }

    /** Create an order. */
    #[Route('/orders', name: 'createOrder', methods: ['POST'])]
    public function createOrder(Request $request): Response
    {
        $values = OrderInput::createValues($this->body->read($request, OrderInput::create()));

        return $this->answer(OrderPresenter::one($this->service->createOrder($values)), 201);
    }

    /** Replace an order. */
    #[Route('/orders/{id}', name: 'replaceOrder', methods: ['PUT'])]
    public function replaceOrder(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $values = OrderInput::createValues($this->body->read($request, OrderInput::create()));

        return $this->answer(OrderPresenter::one($this->service->replaceOrder($key, $values)), 200);
    }

    /** Update part of an order. */
    #[Route('/orders/{id}', name: 'updateOrder', methods: ['PATCH'])]
    public function updateOrder(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $values = OrderInput::updateValues($this->body->read($request, OrderInput::update()));

        return $this->answer(OrderPresenter::one($this->service->updateOrder($key, $values)), 200);
    }

    /** Delete an order. */
    #[Route('/orders/{id}', name: 'deleteOrder', methods: ['DELETE'])]
    public function deleteOrder(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $this->service->deleteOrder($key);

        return $this->empty(204);
    }
}
