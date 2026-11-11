<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreCategoryRequest;
use App\Http\Requests\UpdateCategoryRequest;
use App\Http\Resources\CategoryResource;
use App\Services\CategoryService;
use App\Support\ListQuery;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Routes of categories: HTTP in, service calls, HTTP out. */
final class CategoryController extends Controller
{
    public function __construct(private readonly CategoryService $service)
    {
    }

    /** List categories. */
    public function listCategories(Request $request): Response
    {
        $query = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'size' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filters = [];
        $page = (int) ($query['page'] ?? 1);
        $size = (int) ($query['size'] ?? 20);
        $result = $this->service->listCategories(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return response()->json(['items' => CategoryResource::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get a category. */
    public function getCategory(string $id): Response
    {
        $key = $this->integerKey($id, 'id');

        return response()->json(CategoryResource::one($this->service->getCategory($key)), 200);
    }

    /** Create a category. */
    public function createCategory(StoreCategoryRequest $request): Response
    {
        $values = $request->values();

        return response()->json(CategoryResource::one($this->service->createCategory($values)), 201);
    }

    /** Replace a category. */
    public function replaceCategory(StoreCategoryRequest $request, string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $values = $request->values();

        return response()->json(CategoryResource::one($this->service->replaceCategory($key, $values)), 200);
    }

    /** Update part of a category. */
    public function updateCategory(UpdateCategoryRequest $request, string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $values = $request->values();

        return response()->json(CategoryResource::one($this->service->updateCategory($key, $values)), 200);
    }

    /** Delete a category. */
    public function deleteCategory(string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $this->service->deleteCategory($key);

        return response()->noContent(204);
    }
}
