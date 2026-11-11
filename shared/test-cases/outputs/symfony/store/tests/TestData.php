<?php

namespace App\Tests;

/** Credentials for the tests, builders of valid request bodies, and helpers that create items through the API. */
trait TestData
{
    /** @return array<string, string> Headers of a client allowed to call every endpoint. */
    protected function headers(): array
    {
        return [];
    }

    /**
     * A valid body to create a customer, with the items it refers to created first.
     *
     * @return array<string, mixed>
     */
    protected function customerPayload(int $variant = 0): array
    {
        $body = $variant === 0 ? ['name' => 'name 1', 'email' => 'email 1', 'password' => 'password 1', 'phone' => 'phone 1', 'address' => ['street' => 'street 1', 'city' => 'city 1', 'postalCode' => 'postalCode 1', 'country' => 'country 1']] : ['name' => 'name 2', 'email' => 'email 2', 'password' => 'password 2', 'phone' => 'phone 2', 'address' => ['street' => 'street 2', 'city' => 'city 2', 'postalCode' => 'postalCode 2', 'country' => 'country 2']];

        return $body;
    }

    /**
     * Creates a customer and returns it as the API answers.
     *
     * @return array<string, mixed>
     */
    protected function createCustomer(int $variant = 0): array
    {
        $response = $this->postJson('/customers', $this->customerPayload($variant), $this->headers());
        $response->assertStatus(201);

        return $response->json();
    }

    /**
     * A valid body to create a product, with the items it refers to created first.
     *
     * @return array<string, mixed>
     */
    protected function productPayload(int $variant = 0): array
    {
        $body = $variant === 0 ? ['sku' => 'sku 1', 'name' => 'name 1', 'description' => 'description 1', 'price' => 1.5, 'stock' => 1.5, 'active' => true] : ['sku' => 'sku 2', 'name' => 'name 2', 'description' => 'description 2', 'price' => 2, 'stock' => 2, 'active' => false];

        return $body;
    }

    /**
     * Creates a product and returns it as the API answers.
     *
     * @return array<string, mixed>
     */
    protected function createProduct(int $variant = 0): array
    {
        $response = $this->postJson('/products', $this->productPayload($variant), $this->headers());
        $response->assertStatus(201);

        return $response->json();
    }

    /**
     * A valid body to create an order, with the items it refers to created first.
     *
     * @return array<string, mixed>
     */
    protected function orderPayload(int $variant = 0): array
    {
        $body = $variant === 0 ? ['customerId' => null, 'lines' => [['productId' => null, 'quantity' => 1.5, 'unitPrice' => 1.5]], 'status' => 'pending', 'total' => 1.5, 'notes' => 'notes 1'] : ['customerId' => null, 'lines' => [['productId' => null, 'quantity' => 2, 'unitPrice' => 2]], 'status' => 'paid', 'total' => 2, 'notes' => 'notes 2'];
        $body['customerId'] = $this->createCustomer()['id'];
        $body['lines'][0]['productId'] = $this->createProduct()['id'];

        return $body;
    }

    /**
     * Creates an order and returns it as the API answers.
     *
     * @return array<string, mixed>
     */
    protected function createOrder(int $variant = 0): array
    {
        $response = $this->postJson('/orders', $this->orderPayload($variant), $this->headers());
        $response->assertStatus(201);

        return $response->json();
    }
}
