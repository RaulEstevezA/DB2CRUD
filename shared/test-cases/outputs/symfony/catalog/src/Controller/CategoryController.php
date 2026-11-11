<?php

namespace App\Controller;

use App\Http\JsonBody;
use App\Input\CategoryInput;
use App\Presenter\CategoryPresenter;
use App\Service\CategoryService;
use App\Support\ListQuery;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Routing\Attribute\Route;

/** Routes of categories: HTTP in, service calls, HTTP out. */
#[AsController]
final class CategoryController extends ApiController
{
    public function __construct(
        private readonly CategoryService $service,
        private readonly JsonBody $body,
    ) {
    }

    /** List categories. */
    #[Route('/categories', name: 'listCategories', methods: ['GET'])]
    public function listCategories(Request $request): Response
    {
        $page = $this->integerQuery($request, 'page', 1, 1);
        $size = $this->integerQuery($request, 'size', 20, 1, 100);
        $filters = [];
        $result = $this->service->listCategories(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return $this->answer(['items' => CategoryPresenter::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get a category. */
    #[Route('/categories/{id}', name: 'getCategory', methods: ['GET'])]
    public function getCategory(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');

        return $this->answer(CategoryPresenter::one($this->service->getCategory($key)), 200);
    }

    /** Create a category. */
    #[Route('/categories', name: 'createCategory', methods: ['POST'])]
    public function createCategory(Request $request): Response
    {
        $values = CategoryInput::createValues($this->body->read($request, CategoryInput::create()));

        return $this->answer(CategoryPresenter::one($this->service->createCategory($values)), 201);
    }

    /** Replace a category. */
    #[Route('/categories/{id}', name: 'replaceCategory', methods: ['PUT'])]
    public function replaceCategory(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $values = CategoryInput::createValues($this->body->read($request, CategoryInput::create()));

        return $this->answer(CategoryPresenter::one($this->service->replaceCategory($key, $values)), 200);
    }

    /** Update part of a category. */
    #[Route('/categories/{id}', name: 'updateCategory', methods: ['PATCH'])]
    public function updateCategory(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $values = CategoryInput::updateValues($this->body->read($request, CategoryInput::update()));

        return $this->answer(CategoryPresenter::one($this->service->updateCategory($key, $values)), 200);
    }

    /** Delete a category. */
    #[Route('/categories/{id}', name: 'deleteCategory', methods: ['DELETE'])]
    public function deleteCategory(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $this->service->deleteCategory($key);

        return $this->empty(204);
    }
}
