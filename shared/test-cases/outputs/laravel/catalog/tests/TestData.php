<?php

namespace Tests;

/** Credentials for the tests, builders of valid request bodies, and helpers that create items through the API. */
trait TestData
{
    /** @return array<string, string> Headers of a client allowed to call every endpoint. */
    protected function headers(): array
    {
        return [];
    }

    /**
     * A valid body to create a category, with the items it refers to created first.
     *
     * @return array<string, mixed>
     */
    protected function categoryPayload(int $variant = 0): array
    {
        $body = $variant === 0 ? ['name' => 'name 1'] : ['name' => 'name 2'];

        return $body;
    }

    /**
     * Creates a category and returns it as the API answers.
     *
     * @return array<string, mixed>
     */
    protected function createCategory(int $variant = 0): array
    {
        $response = $this->postJson('/categories', $this->categoryPayload($variant), $this->headers());
        $response->assertStatus(201);

        return $response->json();
    }

    /**
     * A valid body to create an item, with the items it refers to created first.
     *
     * @return array<string, mixed>
     */
    protected function itemPayload(int $variant = 0): array
    {
        $body = $variant === 0 ? ['name' => 'name 1', 'price' => 0, 'supplierEmail' => 'user1@example.com', 'categoryId' => null, 'stock' => 0] : ['name' => 'name 2', 'price' => 0.5, 'supplierEmail' => 'user2@example.com', 'categoryId' => null, 'stock' => 1];
        $body['categoryId'] = $this->createCategory()['id'];

        return $body;
    }

    /**
     * Creates an item and returns it as the API answers.
     *
     * @return array<string, mixed>
     */
    protected function createItem(int $variant = 0): array
    {
        $response = $this->postJson('/items', $this->itemPayload($variant), $this->headers());
        $response->assertStatus(201);

        return $response->json();
    }
}
