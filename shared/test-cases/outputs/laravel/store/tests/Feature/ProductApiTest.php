<?php

namespace Tests\Feature;

use Tests\TestCase;
use Tests\TestData;

/** Tests of the products endpoints. */
final class ProductApiTest extends TestCase
{
    use TestData;

    public function test_creates_a_product(): void
    {
        $payload = $this->productPayload();

        $response = $this->postJson('/products', $payload, $this->headers());

        $response->assertStatus(201);
        $body = $response->json();
        $this->assertArrayHasKey('id', $body);
        $this->assertSame($payload['sku'], $body['sku']);
        $this->assertSame($payload['name'], $body['name']);
        $this->assertSame($payload['description'], $body['description']);
        $this->assertSame($payload['active'], $body['active']);
    }

    public function test_rejects_a_product_without_sku(): void
    {
        $payload = $this->productPayload();
        unset($payload['sku']);

        $response = $this->postJson('/products', $payload, $this->headers());

        $response->assertStatus(400);
        $this->assertSame('validation_error', $response->json('error.code'));
        $this->assertContains('sku', array_column($response->json('error.details'), 'field'));
    }

    public function test_gets_a_product(): void
    {
        $created = $this->createProduct();
        $key = $created['id'];

        $response = $this->getJson('/products/'.$key, $this->headers());

        $response->assertStatus(200);
        $this->assertEquals($created, $response->json());
    }

    public function test_answers_404_for_a_missing_product(): void
    {
        $response = $this->getJson('/products/999999', $this->headers());

        $response->assertStatus(404);
        $this->assertSame('not_found', $response->json('error.code'));
    }

    public function test_lists_products(): void
    {
        $this->createProduct();
        $this->createProduct(1);

        $response = $this->getJson('/products', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertSame(1, $response->json('page'));
    }

    public function test_lists_products_by_page(): void
    {
        $this->createProduct();
        $this->createProduct(1);

        $response = $this->getJson('/products?page=2&size=1', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertCount(1, $response->json('items'));
        $this->assertSame(2, $response->json('page'));
    }

    public function test_rejects_a_page_that_does_not_exist(): void
    {
        $response = $this->getJson('/products?page=0', $this->headers());

        $response->assertStatus(400);
    }

    public function test_replaces_a_product(): void
    {
        $created = $this->createProduct();
        $key = $created['id'];
        $payload = $this->productPayload(1);

        $response = $this->putJson('/products/'.$key, $payload, $this->headers());

        $response->assertStatus(200);
        $this->assertSame($payload['sku'], $response->json()['sku']);
        $this->assertSame($payload['name'], $response->json()['name']);
        $this->assertSame($payload['description'], $response->json()['description']);
        $this->assertSame($payload['active'], $response->json()['active']);
    }

    public function test_updates_part_of_a_product(): void
    {
        $created = $this->createProduct();
        $key = $created['id'];

        $response = $this->patchJson('/products/'.$key, ['sku' => 'sku 2'], $this->headers());

        $response->assertStatus(200);
        $this->assertEquals('sku 2', $response->json()['sku']);
    }

    public function test_rejects_null_for_sku(): void
    {
        $created = $this->createProduct();
        $key = $created['id'];

        $response = $this->patchJson('/products/'.$key, ['sku' => null], $this->headers());

        $response->assertStatus(400);
    }

    public function test_deletes_a_product(): void
    {
        $created = $this->createProduct();
        $key = $created['id'];

        $response = $this->deleteJson('/products/'.$key, [], $this->headers());

        $response->assertStatus(204);
        $this->getJson('/products/'.$key, $this->headers())->assertStatus(404);
    }
}
