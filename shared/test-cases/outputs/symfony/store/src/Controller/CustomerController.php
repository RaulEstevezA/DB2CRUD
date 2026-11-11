<?php

namespace App\Controller;

use App\Http\JsonBody;
use App\Input\CustomerInput;
use App\Presenter\CustomerPresenter;
use App\Service\CustomerService;
use App\Support\ListQuery;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Attribute\AsController;
use Symfony\Component\Routing\Attribute\Route;

/** Routes of customers: HTTP in, service calls, HTTP out. */
#[AsController]
final class CustomerController extends ApiController
{
    public function __construct(
        private readonly CustomerService $service,
        private readonly JsonBody $body,
    ) {
    }

    /** List customers. */
    #[Route('/customers', name: 'listCustomers', methods: ['GET'])]
    public function listCustomers(Request $request): Response
    {
        $page = $this->integerQuery($request, 'page', 1, 1);
        $size = $this->integerQuery($request, 'size', 20, 1, 100);
        $filters = [];
        $result = $this->service->listCustomers(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return $this->answer(['items' => CustomerPresenter::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get a customer. */
    #[Route('/customers/{id}', name: 'getCustomer', methods: ['GET'])]
    public function getCustomer(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');

        return $this->answer(CustomerPresenter::one($this->service->getCustomer($key)), 200);
    }

    /** Create a customer. */
    #[Route('/customers', name: 'createCustomer', methods: ['POST'])]
    public function createCustomer(Request $request): Response
    {
        $values = CustomerInput::createValues($this->body->read($request, CustomerInput::create()));

        return $this->answer(CustomerPresenter::one($this->service->createCustomer($values)), 201);
    }

    /** Replace a customer. */
    #[Route('/customers/{id}', name: 'replaceCustomer', methods: ['PUT'])]
    public function replaceCustomer(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $values = CustomerInput::createValues($this->body->read($request, CustomerInput::create()));

        return $this->answer(CustomerPresenter::one($this->service->replaceCustomer($key, $values)), 200);
    }

    /** Update part of a customer. */
    #[Route('/customers/{id}', name: 'updateCustomer', methods: ['PATCH'])]
    public function updateCustomer(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $values = CustomerInput::updateValues($this->body->read($request, CustomerInput::update()));

        return $this->answer(CustomerPresenter::one($this->service->updateCustomer($key, $values)), 200);
    }

    /** Delete a customer. */
    #[Route('/customers/{id}', name: 'deleteCustomer', methods: ['DELETE'])]
    public function deleteCustomer(Request $request): Response
    {
        $key = $this->integerKey($request, 'id');
        $this->service->deleteCustomer($key);

        return $this->empty(204);
    }
}
