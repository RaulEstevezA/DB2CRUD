<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreAuthorRequest;
use App\Http\Requests\UpdateAuthorRequest;
use App\Http\Resources\AuthorResource;
use App\Services\AuthorService;
use App\Support\ListQuery;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Routes of authors: HTTP in, service calls, HTTP out. */
final class AuthorController extends Controller
{
    public function __construct(private readonly AuthorService $service)
    {
    }

    /** List authors. */
    public function listAuthors(Request $request): Response
    {
        $query = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'size' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filters = [];
        $page = (int) ($query['page'] ?? 1);
        $size = (int) ($query['size'] ?? 20);
        $result = $this->service->listAuthors(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return response()->json(['items' => AuthorResource::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get an author. */
    public function getAuthor(string $id): Response
    {
        $key = $this->uuidKey($id, 'id');

        return response()->json(AuthorResource::one($this->service->getAuthor($key)), 200);
    }

    /** Create an author. */
    public function createAuthor(StoreAuthorRequest $request): Response
    {
        $values = $request->values();

        return response()->json(AuthorResource::one($this->service->createAuthor($values)), 201);
    }

    /** Replace an author. */
    public function replaceAuthor(StoreAuthorRequest $request, string $id): Response
    {
        $key = $this->uuidKey($id, 'id');
        $values = $request->values();

        return response()->json(AuthorResource::one($this->service->replaceAuthor($key, $values)), 200);
    }

    /** Update part of an author. */
    public function updateAuthor(UpdateAuthorRequest $request, string $id): Response
    {
        $key = $this->uuidKey($id, 'id');
        $values = $request->values();

        return response()->json(AuthorResource::one($this->service->updateAuthor($key, $values)), 200);
    }

    /** Delete an author. */
    public function deleteAuthor(string $id): Response
    {
        $key = $this->uuidKey($id, 'id');
        $this->service->deleteAuthor($key);

        return response()->noContent(204);
    }
}
