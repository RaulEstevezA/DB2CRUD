<?php

namespace App\Controller;

use App\Http\JsonBody;
use App\Input\ProductInput;
use App\Presenter\ProductPresenter;
use App\Service\ProductService;
use App\Support\ListQuery;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Routing\Attribute\Route;

/** Routes of products: HTTP in, service calls, HTTP out. */
#[AsController]
final class ProductController extends ApiController
{
    public function __construct(
        private readonly ProductService $service,
        private readonly JsonBody $body,
    ) {
    }

    /** List products. */
    #[Route('/products', name: 'listProducts', methods: ['GET'])]
    public function listProducts(Request $request): Response
    {
        $page = $this->integerQuery($request, 'page', 1, 1);
        $size = $this->integerQuery($request, 'size', 20, 1, 100);
        $filters = [];
        $result = $this->service->listProducts(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return $this->answer(['items' => ProductPresenter::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get a product. */
    #[Route('/products/{id}', name: 'getProduct', methods: ['GET'])]
    public function getProduct(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');

        return $this->answer(ProductPresenter::one($this->service->getProduct($key)), 200);
    }

    /** Create a product. */
    #[Route('/products', name: 'createProduct', methods: ['POST'])]
    public function createProduct(Request $request): Response
    {
        $values = ProductInput::createValues($this->body->read($request, ProductInput::create()));

        return $this->answer(ProductPresenter::one($this->service->createProduct($values)), 201);
    }

    /** Replace a product. */
    #[Route('/products/{id}', name: 'replaceProduct', methods: ['PUT'])]
    public function replaceProduct(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $values = ProductInput::createValues($this->body->read($request, ProductInput::create()));

        return $this->answer(ProductPresenter::one($this->service->replaceProduct($key, $values)), 200);
    }

    /** Update part of a product. */
    #[Route('/products/{id}', name: 'updateProduct', methods: ['PATCH'])]
    public function updateProduct(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $values = ProductInput::updateValues($this->body->read($request, ProductInput::update()));

        return $this->answer(ProductPresenter::one($this->service->updateProduct($key, $values)), 200);
    }

    /** Delete a product. */
    #[Route('/products/{id}', name: 'deleteProduct', methods: ['DELETE'])]
    public function deleteProduct(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $this->service->deleteProduct($key);

        return $this->empty(204);
    }
}
