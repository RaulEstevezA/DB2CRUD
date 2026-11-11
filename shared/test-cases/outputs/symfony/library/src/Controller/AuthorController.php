<?php

namespace App\Controller;

use App\Http\JsonBody;
use App\Input\AuthorInput;
use App\Presenter\AuthorPresenter;
use App\Service\AuthorService;
use App\Support\ListQuery;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Routing\Attribute\Route;

/** Routes of authors: HTTP in, service calls, HTTP out. */
#[AsController]
final class AuthorController extends ApiController
{
    public function __construct(
        private readonly AuthorService $service,
        private readonly JsonBody $body,
    ) {
    }

    /** List authors. */
    #[Route('/authors', name: 'listAuthors', methods: ['GET'])]
    public function listAuthors(Request $request): Response
    {
        $page = $this->integerQuery($request, 'page', 1, 1);
        $size = $this->integerQuery($request, 'size', 20, 1, 100);
        $filters = [];
        $result = $this->service->listAuthors(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return $this->answer(['items' => AuthorPresenter::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get an author. */
    #[Route('/authors/{id}', name: 'getAuthor', methods: ['GET'])]
    public function getAuthor(Request $request): Response
    {
        $key = $this->uuidKey($request, 'id');

        return $this->answer(AuthorPresenter::one($this->service->getAuthor($key)), 200);
    }

    /** Create an author. */
    #[Route('/authors', name: 'createAuthor', methods: ['POST'])]
    public function createAuthor(Request $request): Response
    {
        $values = AuthorInput::createValues($this->body->read($request, AuthorInput::create()));

        return $this->answer(AuthorPresenter::one($this->service->createAuthor($values)), 201);
    }

    /** Replace an author. */
    #[Route('/authors/{id}', name: 'replaceAuthor', methods: ['PUT'])]
    public function replaceAuthor(Request $request): Response
    {
        $key = $this->uuidKey($request, 'id');
        $values = AuthorInput::createValues($this->body->read($request, AuthorInput::create()));

        return $this->answer(AuthorPresenter::one($this->service->replaceAuthor($key, $values)), 200);
    }

    /** Update part of an author. */
    #[Route('/authors/{id}', name: 'updateAuthor', methods: ['PATCH'])]
    public function updateAuthor(Request $request): Response
    {
        $key = $this->uuidKey($request, 'id');
        $values = AuthorInput::updateValues($this->body->read($request, AuthorInput::update()));

        return $this->answer(AuthorPresenter::one($this->service->updateAuthor($key, $values)), 200);
    }

    /** Delete an author. */
    #[Route('/authors/{id}', name: 'deleteAuthor', methods: ['DELETE'])]
    public function deleteAuthor(Request $request): Response
    {
        $key = $this->uuidKey($request, 'id');
        $this->service->deleteAuthor($key);

        return $this->empty(204);
    }
}
