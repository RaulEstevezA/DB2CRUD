<?php

namespace App\Tests\Api;

use App\Tests\ApiTestCase;
use App\Tests\TestData;

/** Tests of the authors endpoints. */
final class AuthorApiTest extends ApiTestCase
{
    use TestData;

    public function test_creates_an_author(): void
    {
        $payload = $this->authorPayload();

        $response = $this->postJson('/authors', $payload, $this->headers());

        $response->assertStatus(201);
        $body = $response->json();
        $this->assertArrayHasKey('id', $body);
        $this->assertSame($payload['name'], $body['name']);
    }

    public function test_rejects_an_author_without_name(): void
    {
        $payload = $this->authorPayload();
        unset($payload['name']);

        $response = $this->postJson('/authors', $payload, $this->headers());

        $response->assertStatus(400);
        $this->assertSame('validation_error', $response->json('error.code'));
        $this->assertContains('name', array_column($response->json('error.details'), 'field'));
    }

    public function test_gets_an_author(): void
    {
        $created = $this->createAuthor();
        $key = $created['id'];

        $response = $this->getJson('/authors/'.$key, $this->headers());

        $response->assertStatus(200);
        $this->assertEquals($created, $response->json());
    }

    public function test_answers_404_for_a_missing_author(): void
    {
        $response = $this->getJson('/authors/00000000-0000-0000-0000-000000000000', $this->headers());

        $response->assertStatus(404);
        $this->assertSame('not_found', $response->json('error.code'));
    }

    public function test_lists_authors(): void
    {
        $this->createAuthor();
        $this->createAuthor(1);

        $response = $this->getJson('/authors', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertSame(1, $response->json('page'));
    }

    public function test_lists_authors_by_page(): void
    {
        $this->createAuthor();
        $this->createAuthor(1);

        $response = $this->getJson('/authors?page=2&size=1', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertCount(1, $response->json('items'));
        $this->assertSame(2, $response->json('page'));
    }

    public function test_rejects_a_page_that_does_not_exist(): void
    {
        $response = $this->getJson('/authors?page=0', $this->headers());

        $response->assertStatus(400);
    }

    public function test_replaces_an_author(): void
    {
        $created = $this->createAuthor();
        $key = $created['id'];
        $payload = $this->authorPayload(1);

        $response = $this->putJson('/authors/'.$key, $payload, $this->headers());

        $response->assertStatus(200);
        $this->assertSame($payload['name'], $response->json()['name']);
    }

    public function test_updates_part_of_an_author(): void
    {
        $created = $this->createAuthor();
        $key = $created['id'];

        $response = $this->patchJson('/authors/'.$key, ['name' => 'name 2'], $this->headers());

        $response->assertStatus(200);
        $this->assertEquals('name 2', $response->json()['name']);
    }

    public function test_rejects_null_for_name(): void
    {
        $created = $this->createAuthor();
        $key = $created['id'];

        $response = $this->patchJson('/authors/'.$key, ['name' => null], $this->headers());

        $response->assertStatus(400);
    }

    public function test_deletes_an_author(): void
    {
        $created = $this->createAuthor();
        $key = $created['id'];

        $response = $this->deleteJson('/authors/'.$key, [], $this->headers());

        $response->assertStatus(204);
        $this->getJson('/authors/'.$key, $this->headers())->assertStatus(404);
    }
}
