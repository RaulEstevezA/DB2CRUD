<?php

namespace Tests\Feature;

use Tests\TestCase;
use Tests\TestData;

/** Tests of the customers endpoints. */
final class CustomerApiTest extends TestCase
{
    use TestData;

    public function test_creates_a_customer(): void
    {
        $payload = $this->customerPayload();

        $response = $this->postJson('/customers', $payload, $this->headers());

        $response->assertStatus(201);
        $body = $response->json();
        $this->assertArrayHasKey('id', $body);
        $this->assertSame($payload['name'], $body['name']);
        $this->assertSame($payload['email'], $body['email']);
        $this->assertSame($payload['phone'], $body['phone']);
    }

    public function test_rejects_a_customer_without_name(): void
    {
        $payload = $this->customerPayload();
        unset($payload['name']);

        $response = $this->postJson('/customers', $payload, $this->headers());

        $response->assertStatus(400);
        $this->assertSame('validation_error', $response->json('error.code'));
        $this->assertContains('name', array_column($response->json('error.details'), 'field'));
    }

    public function test_gets_a_customer(): void
    {
        $created = $this->createCustomer();
        $key = $created['id'];

        $response = $this->getJson('/customers/'.$key, $this->headers());

        $response->assertStatus(200);
        $this->assertEquals($created, $response->json());
    }

    public function test_answers_404_for_a_missing_customer(): void
    {
        $response = $this->getJson('/customers/999999', $this->headers());

        $response->assertStatus(404);
        $this->assertSame('not_found', $response->json('error.code'));
    }

    public function test_lists_customers(): void
    {
        $this->createCustomer();
        $this->createCustomer(1);

        $response = $this->getJson('/customers', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertSame(1, $response->json('page'));
    }

    public function test_lists_customers_by_page(): void
    {
        $this->createCustomer();
        $this->createCustomer(1);

        $response = $this->getJson('/customers?page=2&size=1', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertCount(1, $response->json('items'));
        $this->assertSame(2, $response->json('page'));
    }

    public function test_rejects_a_page_that_does_not_exist(): void
    {
        $response = $this->getJson('/customers?page=0', $this->headers());

        $response->assertStatus(400);
    }

    public function test_replaces_a_customer(): void
    {
        $created = $this->createCustomer();
        $key = $created['id'];
        $payload = $this->customerPayload(1);

        $response = $this->putJson('/customers/'.$key, $payload, $this->headers());

        $response->assertStatus(200);
        $this->assertSame($payload['name'], $response->json()['name']);
        $this->assertSame($payload['email'], $response->json()['email']);
        $this->assertSame($payload['phone'], $response->json()['phone']);
    }

    public function test_updates_part_of_a_customer(): void
    {
        $created = $this->createCustomer();
        $key = $created['id'];

        $response = $this->patchJson('/customers/'.$key, ['name' => 'name 2'], $this->headers());

        $response->assertStatus(200);
        $this->assertEquals('name 2', $response->json()['name']);
    }

    public function test_rejects_null_for_name(): void
    {
        $created = $this->createCustomer();
        $key = $created['id'];

        $response = $this->patchJson('/customers/'.$key, ['name' => null], $this->headers());

        $response->assertStatus(400);
    }

    public function test_deletes_a_customer(): void
    {
        $created = $this->createCustomer();
        $key = $created['id'];

        $response = $this->deleteJson('/customers/'.$key, [], $this->headers());

        $response->assertStatus(204);
        $this->getJson('/customers/'.$key, $this->headers())->assertStatus(404);
    }
}
