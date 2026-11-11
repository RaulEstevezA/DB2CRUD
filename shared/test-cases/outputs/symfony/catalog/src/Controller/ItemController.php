<?php

namespace App\Controller;

use App\Http\JsonBody;
use App\Input\ItemInput;
use App\Presenter\ItemPresenter;
use App\Service\ItemService;
use App\Support\ListQuery;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Routing\Attribute\Route;

/** Routes of items: HTTP in, service calls, HTTP out. */
#[AsController]
final class ItemController extends ApiController
{
    public function __construct(
        private readonly ItemService $service,
        private readonly JsonBody $body,
    ) {
    }

    /** List items. */
    #[Route('/items', name: 'listItems', methods: ['GET'])]
    public function listItems(Request $request): Response
    {
        $page = $this->integerQuery($request, 'page', 1, 1);
        $size = $this->integerQuery($request, 'size', 20, 1, 100);
        $filters = [];
        $result = $this->service->listItems(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return $this->answer(['items' => ItemPresenter::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get an item. */
    #[Route('/items/{id}', name: 'getItem', methods: ['GET'])]
    public function getItem(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');

        return $this->answer(ItemPresenter::one($this->service->getItem($key)), 200);
    }

    /** Create an item. */
    #[Route('/items', name: 'createItem', methods: ['POST'])]
    public function createItem(Request $request): Response
    {
        $values = ItemInput::createValues($this->body->read($request, ItemInput::create()));

        return $this->answer(ItemPresenter::one($this->service->createItem($values)), 201);
    }

    /** Replace an item. */
    #[Route('/items/{id}', name: 'replaceItem', methods: ['PUT'])]
    public function replaceItem(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $values = ItemInput::createValues($this->body->read($request, ItemInput::create()));

        return $this->answer(ItemPresenter::one($this->service->replaceItem($key, $values)), 200);
    }

    /** Update part of an item. */
    #[Route('/items/{id}', name: 'updateItem', methods: ['PATCH'])]
    public function updateItem(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $values = ItemInput::updateValues($this->body->read($request, ItemInput::update()));

        return $this->answer(ItemPresenter::one($this->service->updateItem($key, $values)), 200);
    }

    /** Delete an item. */
    #[Route('/items/{id}', name: 'deleteItem', methods: ['DELETE'])]
    public function deleteItem(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $this->service->deleteItem($key);

        return $this->empty(204);
    }
}
