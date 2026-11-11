<?php

namespace Tests\Feature;

use Tests\TestCase;
use Tests\TestData;

/** Tests of the orders endpoints. */
final class OrderApiTest extends TestCase
{
    use TestData;

    public function test_creates_an_order(): void
    {
        $payload = $this->orderPayload();

        $response = $this->postJson('/orders', $payload, $this->headers());

        $response->assertStatus(201);
        $body = $response->json();
        $this->assertArrayHasKey('id', $body);
        $this->assertSame($payload['status'], $body['status']);
        $this->assertSame($payload['notes'], $body['notes']);
    }

    public function test_rejects_an_order_without_lines(): void
    {
        $payload = $this->orderPayload();
        unset($payload['lines']);

        $response = $this->postJson('/orders', $payload, $this->headers());

        $response->assertStatus(400);
        $this->assertSame('validation_error', $response->json('error.code'));
        $this->assertContains('lines', array_column($response->json('error.details'), 'field'));
    }

    public function test_gets_an_order(): void
    {
        $created = $this->createOrder();
        $key = $created['id'];

        $response = $this->getJson('/orders/'.$key, $this->headers());

        $response->assertStatus(200);
        $this->assertEquals($created, $response->json());
    }

    public function test_answers_404_for_a_missing_order(): void
    {
        $response = $this->getJson('/orders/999999', $this->headers());

        $response->assertStatus(404);
        $this->assertSame('not_found', $response->json('error.code'));
    }

    public function test_lists_orders(): void
    {
        $this->createOrder();
        $this->createOrder(1);

        $response = $this->getJson('/orders', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertSame(1, $response->json('page'));
    }

    public function test_lists_orders_by_page(): void
    {
        $this->createOrder();
        $this->createOrder(1);

        $response = $this->getJson('/orders?page=2&size=1', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertCount(1, $response->json('items'));
        $this->assertSame(2, $response->json('page'));
    }

    public function test_rejects_a_page_that_does_not_exist(): void
    {
        $response = $this->getJson('/orders?page=0', $this->headers());

        $response->assertStatus(400);
    }

    public function test_replaces_an_order(): void
    {
        $created = $this->createOrder();
        $key = $created['id'];
        $payload = $this->orderPayload(1);

        $response = $this->putJson('/orders/'.$key, $payload, $this->headers());

        $response->assertStatus(200);
        $this->assertSame($payload['status'], $response->json()['status']);
        $this->assertSame($payload['notes'], $response->json()['notes']);
    }

    public function test_updates_part_of_an_order(): void
    {
        $created = $this->createOrder();
        $key = $created['id'];

        $response = $this->patchJson('/orders/'.$key, ['total' => 2], $this->headers());

        $response->assertStatus(200);
        $this->assertEquals(2, $response->json()['total']);
    }

    public function test_rejects_null_for_total(): void
    {
        $created = $this->createOrder();
        $key = $created['id'];

        $response = $this->patchJson('/orders/'.$key, ['total' => null], $this->headers());

        $response->assertStatus(400);
    }

    public function test_deletes_an_order(): void
    {
        $created = $this->createOrder();
        $key = $created['id'];

        $response = $this->deleteJson('/orders/'.$key, [], $this->headers());

        $response->assertStatus(204);
        $this->getJson('/orders/'.$key, $this->headers())->assertStatus(404);
    }
}
