<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreProductRequest;
use App\Http\Requests\UpdateProductRequest;
use App\Http\Resources\ProductResource;
use App\Services\ProductService;
use App\Support\ListQuery;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Routes of products: HTTP in, service calls, HTTP out. */
final class ProductController extends Controller
{
    public function __construct(private readonly ProductService $service)
    {
    }

    /** List products. */
    public function listProducts(Request $request): Response
    {
        $query = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'size' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filters = [];
        $page = (int) ($query['page'] ?? 1);
        $size = (int) ($query['size'] ?? 20);
        $result = $this->service->listProducts(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return response()->json(['items' => ProductResource::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get a product. */
    public function getProduct(string $id): Response
    {
        $key = $this->integerKey($id, 'id');

        return response()->json(ProductResource::one($this->service->getProduct($key)), 200);
    }

    /** Create a product. */
    public function createProduct(StoreProductRequest $request): Response
    {
        $values = $request->values();

        return response()->json(ProductResource::one($this->service->createProduct($values)), 201);
    }

    /** Replace a product. */
    public function replaceProduct(StoreProductRequest $request, string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $values = $request->values();

        return response()->json(ProductResource::one($this->service->replaceProduct($key, $values)), 200);
    }

    /** Update part of a product. */
    public function updateProduct(UpdateProductRequest $request, string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $values = $request->values();

        return response()->json(ProductResource::one($this->service->updateProduct($key, $values)), 200);
    }

    /** Delete a product. */
    public function deleteProduct(string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $this->service->deleteProduct($key);

        return response()->noContent(204);
    }
}
