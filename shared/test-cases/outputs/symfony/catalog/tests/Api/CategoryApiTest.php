<?php

namespace App\Tests\Api;

use App\Tests\ApiTestCase;
use App\Tests\TestData;

/** Tests of the categories endpoints. */
final class CategoryApiTest extends ApiTestCase
{
    use TestData;

    public function test_creates_a_category(): void
    {
        $payload = $this->categoryPayload();

        $response = $this->postJson('/categories', $payload, $this->headers());

        $response->assertStatus(201);
        $body = $response->json();
        $this->assertArrayHasKey('id', $body);
        $this->assertSame($payload['name'], $body['name']);
    }

    public function test_rejects_a_category_without_name(): void
    {
        $payload = $this->categoryPayload();
        unset($payload['name']);

        $response = $this->postJson('/categories', $payload, $this->headers());

        $response->assertStatus(400);
        $this->assertSame('validation_error', $response->json('error.code'));
        $this->assertContains('name', array_column($response->json('error.details'), 'field'));
    }

    public function test_gets_a_category(): void
    {
        $created = $this->createCategory();
        $key = $created['id'];

        $response = $this->getJson('/categories/'.$key, $this->headers());

        $response->assertStatus(200);
        $this->assertEquals($created, $response->json());
    }

    public function test_answers_404_for_a_missing_category(): void
    {
        $response = $this->getJson('/categories/999999', $this->headers());

        $response->assertStatus(404);
        $this->assertSame('not_found', $response->json('error.code'));
    }

    public function test_lists_categories(): void
    {
        $this->createCategory();
        $this->createCategory(1);

        $response = $this->getJson('/categories', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertSame(1, $response->json('page'));
    }

    public function test_lists_categories_by_page(): void
    {
        $this->createCategory();
        $this->createCategory(1);

        $response = $this->getJson('/categories?page=2&size=1', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertCount(1, $response->json('items'));
        $this->assertSame(2, $response->json('page'));
    }

    public function test_rejects_a_page_that_does_not_exist(): void
    {
        $response = $this->getJson('/categories?page=0', $this->headers());

        $response->assertStatus(400);
    }

    public function test_replaces_a_category(): void
    {
        $created = $this->createCategory();
        $key = $created['id'];
        $payload = $this->categoryPayload(1);

        $response = $this->putJson('/categories/'.$key, $payload, $this->headers());

        $response->assertStatus(200);
        $this->assertSame($payload['name'], $response->json()['name']);
    }

    public function test_updates_part_of_a_category(): void
    {
        $created = $this->createCategory();
        $key = $created['id'];

        $response = $this->patchJson('/categories/'.$key, ['name' => 'name 2'], $this->headers());

        $response->assertStatus(200);
        $this->assertEquals('name 2', $response->json()['name']);
    }

    public function test_rejects_null_for_name(): void
    {
        $created = $this->createCategory();
        $key = $created['id'];

        $response = $this->patchJson('/categories/'.$key, ['name' => null], $this->headers());

        $response->assertStatus(400);
    }

    public function test_deletes_a_category(): void
    {
        $created = $this->createCategory();
        $key = $created['id'];

        $response = $this->deleteJson('/categories/'.$key, [], $this->headers());

        $response->assertStatus(204);
        $this->getJson('/categories/'.$key, $this->headers())->assertStatus(404);
    }
}
