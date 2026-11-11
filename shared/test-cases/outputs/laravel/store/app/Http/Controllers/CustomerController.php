<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreCustomerRequest;
use App\Http\Requests\UpdateCustomerRequest;
use App\Http\Resources\CustomerResource;
use App\Services\CustomerService;
use App\Support\ListQuery;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Routes of customers: HTTP in, service calls, HTTP out. */
final class CustomerController extends Controller
{
    public function __construct(private readonly CustomerService $service)
    {
    }

    /** List customers. */
    public function listCustomers(Request $request): Response
    {
        $query = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1'],
            'size' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filters = [];
        $page = (int) ($query['page'] ?? 1);
        $size = (int) ($query['size'] ?? 20);
        $result = $this->service->listCustomers(ListQuery::of($filters, null, ($page - 1) * $size, $size));

        return response()->json(['items' => CustomerResource::many($result->items), 'total' => $result->total, 'page' => $page, 'size' => $size], 200);
    }

    /** Get a customer. */
    public function getCustomer(string $id): Response
    {
        $key = $this->integerKey($id, 'id');

        return response()->json(CustomerResource::one($this->service->getCustomer($key)), 200);
    }

    /** Create a customer. */
    public function createCustomer(StoreCustomerRequest $request): Response
    {
        $values = $request->values();

        return response()->json(CustomerResource::one($this->service->createCustomer($values)), 201);
    }

    /** Replace a customer. */
    public function replaceCustomer(StoreCustomerRequest $request, string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $values = $request->values();

        return response()->json(CustomerResource::one($this->service->replaceCustomer($key, $values)), 200);
    }

    /** Update part of a customer. */
    public function updateCustomer(UpdateCustomerRequest $request, string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $values = $request->values();

        return response()->json(CustomerResource::one($this->service->updateCustomer($key, $values)), 200);
    }

    /** Delete a customer. */
    public function deleteCustomer(string $id): Response
    {
        $key = $this->integerKey($id, 'id');
        $this->service->deleteCustomer($key);

        return response()->noContent(204);
    }
}
