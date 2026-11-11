<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreBookRequest;
use App\Http\Requests\UpdateBookRequest;
use App\Http\Resources\BookResource;
use App\Services\BookService;
use App\Support\ListQuery;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Routes of books: HTTP in, service calls, HTTP out. */
final class BookController extends Controller
{
    public function __construct(private readonly BookService $service)
    {
    }

    /** List books. */
    public function listBooks(Request $request): Response
    {
        $query = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'size' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filters = [];
        $page = (int) ($query['page'] ?? 1);
        $size = (int) ($query['size'] ?? 20);
        $result = $this->service->listBooks(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return response()->json(['items' => BookResource::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get a book. */
    public function getBook(string $id): Response
    {
        $key = $this->uuidKey($id, 'id');

        return response()->json(BookResource::one($this->service->getBook($key)), 200);
    }

    /** Create a book. */
    public function createBook(StoreBookRequest $request): Response
    {
        $values = $request->values();

        return response()->json(BookResource::one($this->service->createBook($values)), 201);
    }

    /** Replace a book. */
    public function replaceBook(StoreBookRequest $request, string $id): Response
    {
        $key = $this->uuidKey($id, 'id');
        $values = $request->values();

        return response()->json(BookResource::one($this->service->replaceBook($key, $values)), 200);
    }

    /** Update part of a book. */
    public function updateBook(UpdateBookRequest $request, string $id): Response
    {
        $key = $this->uuidKey($id, 'id');
        $values = $request->values();

        return response()->json(BookResource::one($this->service->updateBook($key, $values)), 200);
    }

    /** Delete a book. */
    public function deleteBook(string $id): Response
    {
        $key = $this->uuidKey($id, 'id');
        $this->service->deleteBook($key);

        return response()->noContent(204);
    }
}
