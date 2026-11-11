<?php

namespace App\Tests\Api;

use App\Tests\ApiTestCase;
use App\Tests\TestData;

/** Tests of the items endpoints. */
final class ItemApiTest extends ApiTestCase
{
    use TestData;

    public function test_creates_an_item(): void
    {
        $payload = $this->itemPayload();

        $response = $this->postJson('/items', $payload, $this->headers());

        $response->assertStatus(201);
        $body = $response->json();
        $this->assertArrayHasKey('id', $body);
        $this->assertSame($payload['name'], $body['name']);
        $this->assertSame($payload['stock'], $body['stock']);
    }

    public function test_rejects_an_item_without_name(): void
    {
        $payload = $this->itemPayload();
        unset($payload['name']);

        $response = $this->postJson('/items', $payload, $this->headers());

        $response->assertStatus(400);
        $this->assertSame('validation_error', $response->json('error.code'));
        $this->assertContains('name', array_column($response->json('error.details'), 'field'));
    }

    public function test_gets_an_item(): void
    {
        $created = $this->createItem();
        $key = $created['id'];

        $response = $this->getJson('/items/'.$key, $this->headers());

        $response->assertStatus(200);
        $this->assertEquals($created, $response->json());
    }

    public function test_answers_404_for_a_missing_item(): void
    {
        $response = $this->getJson('/items/999999', $this->headers());

        $response->assertStatus(404);
        $this->assertSame('not_found', $response->json('error.code'));
    }

    public function test_lists_items(): void
    {
        $this->createItem();
        $this->createItem(1);

        $response = $this->getJson('/items', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertSame(1, $response->json('page'));
    }

    public function test_lists_items_by_page(): void
    {
        $this->createItem();
        $this->createItem(1);

        $response = $this->getJson('/items?page=2&size=1', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertCount(1, $response->json('items'));
        $this->assertSame(2, $response->json('page'));
    }

    public function test_rejects_a_page_that_does_not_exist(): void
    {
        $response = $this->getJson('/items?page=0', $this->headers());

        $response->assertStatus(400);
    }

    public function test_replaces_an_item(): void
    {
        $created = $this->createItem();
        $key = $created['id'];
        $payload = $this->itemPayload(1);

        $response = $this->putJson('/items/'.$key, $payload, $this->headers());

        $response->assertStatus(200);
        $this->assertSame($payload['name'], $response->json()['name']);
        $this->assertSame($payload['stock'], $response->json()['stock']);
    }

    public function test_updates_part_of_an_item(): void
    {
        $created = $this->createItem();
        $key = $created['id'];

        $response = $this->patchJson('/items/'.$key, ['name' => 'name 2'], $this->headers());

        $response->assertStatus(200);
        $this->assertEquals('name 2', $response->json()['name']);
    }

    public function test_rejects_null_for_name(): void
    {
        $created = $this->createItem();
        $key = $created['id'];

        $response = $this->patchJson('/items/'.$key, ['name' => null], $this->headers());

        $response->assertStatus(400);
    }

    public function test_deletes_an_item(): void
    {
        $created = $this->createItem();
        $key = $created['id'];

        $response = $this->deleteJson('/items/'.$key, [], $this->headers());

        $response->assertStatus(204);
        $this->getJson('/items/'.$key, $this->headers())->assertStatus(404);
    }
}
