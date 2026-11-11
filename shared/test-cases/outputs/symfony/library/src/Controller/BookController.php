<?php

namespace App\Controller;

use App\Http\JsonBody;
use App\Input\BookInput;
use App\Presenter\BookPresenter;
use App\Service\BookService;
use App\Support\ListQuery;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Routing\Attribute\Route;

/** Routes of books: HTTP in, service calls, HTTP out. */
#[AsController]
final class BookController extends ApiController
{
    public function __construct(
        private readonly BookService $service,
        private readonly JsonBody $body,
    ) {
    }

    /** List books. */
    #[Route('/books', name: 'listBooks', methods: ['GET'])]
    public function listBooks(Request $request): Response
    {
        $page = $this->integerQuery($request, 'page', 1, 1);
        $size = $this->integerQuery($request, 'size', 20, 1, 100);
        $filters = [];
        $result = $this->service->listBooks(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return $this->answer(['items' => BookPresenter::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get a book. */
    #[Route('/books/{id}', name: 'getBook', methods: ['GET'])]
    public function getBook(Request $request): Response
    {
        $key = $this->uuidKey($request, 'id');

        return $this->answer(BookPresenter::one($this->service->getBook($key)), 200);
    }

    /** Create a book. */
    #[Route('/books', name: 'createBook', methods: ['POST'])]
    public function createBook(Request $request): Response
    {
        $values = BookInput::createValues($this->body->read($request, BookInput::create()));

        return $this->answer(BookPresenter::one($this->service->createBook($values)), 201);
    }

    /** Replace a book. */
    #[Route('/books/{id}', name: 'replaceBook', methods: ['PUT'])]
    public function replaceBook(Request $request): Response
    {
        $key = $this->uuidKey($request, 'id');
        $values = BookInput::createValues($this->body->read($request, BookInput::create()));

        return $this->answer(BookPresenter::one($this->service->replaceBook($key, $values)), 200);
    }

    /** Update part of a book. */
    #[Route('/books/{id}', name: 'updateBook', methods: ['PATCH'])]
    public function updateBook(Request $request): Response
    {
        $key = $this->uuidKey($request, 'id');
        $values = BookInput::updateValues($this->body->read($request, BookInput::update()));

        return $this->answer(BookPresenter::one($this->service->updateBook($key, $values)), 200);
    }

    /** Delete a book. */
    #[Route('/books/{id}', name: 'deleteBook', methods: ['DELETE'])]
    public function deleteBook(Request $request): Response
    {
        $key = $this->uuidKey($request, 'id');
        $this->service->deleteBook($key);

        return $this->empty(204);
    }
}
