<?php

namespace App\Tests\Api;

use App\Tests\ApiTestCase;
use App\Tests\TestData;

/** Tests of the books endpoints. */
final class BookApiTest extends ApiTestCase
{
    use TestData;

    public function test_creates_a_book(): void
    {
        $payload = $this->bookPayload();

        $response = $this->postJson('/books', $payload, $this->headers());

        $response->assertStatus(201);
        $body = $response->json();
        $this->assertArrayHasKey('id', $body);
        $this->assertSame($payload['title'], $body['title']);
        $this->assertSame($payload['isbn'], $body['isbn']);
        $this->assertSame($payload['genre'], $body['genre']);
        $this->assertSame($payload['pages'], $body['pages']);
        $this->assertSame($payload['available'], $body['available']);
    }

    public function test_rejects_a_book_without_title(): void
    {
        $payload = $this->bookPayload();
        unset($payload['title']);

        $response = $this->postJson('/books', $payload, $this->headers());

        $response->assertStatus(400);
        $this->assertSame('validation_error', $response->json('error.code'));
        $this->assertContains('title', array_column($response->json('error.details'), 'field'));
    }

    public function test_gets_a_book(): void
    {
        $created = $this->createBook();
        $key = $created['id'];

        $response = $this->getJson('/books/'.$key, $this->headers());

        $response->assertStatus(200);
        $this->assertEquals($created, $response->json());
    }

    public function test_answers_404_for_a_missing_book(): void
    {
        $response = $this->getJson('/books/00000000-0000-0000-0000-000000000000', $this->headers());

        $response->assertStatus(404);
        $this->assertSame('not_found', $response->json('error.code'));
    }

    public function test_lists_books(): void
    {
        $this->createBook();
        $this->createBook(1);

        $response = $this->getJson('/books', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertSame(1, $response->json('page'));
    }

    public function test_lists_books_by_page(): void
    {
        $this->createBook();
        $this->createBook(1);

        $response = $this->getJson('/books?page=2&size=1', $this->headers());

        $response->assertStatus(200);
        $this->assertSame(2, $response->json('total'));
        $this->assertCount(1, $response->json('items'));
        $this->assertSame(2, $response->json('page'));
    }

    public function test_rejects_a_page_that_does_not_exist(): void
    {
        $response = $this->getJson('/books?page=0', $this->headers());

        $response->assertStatus(400);
    }

    public function test_replaces_a_book(): void
    {
        $created = $this->createBook();
        $key = $created['id'];
        $payload = $this->bookPayload(1);

        $response = $this->putJson('/books/'.$key, $payload, $this->headers());

        $response->assertStatus(200);
        $this->assertSame($payload['title'], $response->json()['title']);
        $this->assertSame($payload['isbn'], $response->json()['isbn']);
        $this->assertSame($payload['genre'], $response->json()['genre']);
        $this->assertSame($payload['pages'], $response->json()['pages']);
        $this->assertSame($payload['available'], $response->json()['available']);
    }

    public function test_updates_part_of_a_book(): void
    {
        $created = $this->createBook();
        $key = $created['id'];

        $response = $this->patchJson('/books/'.$key, ['title' => 'title 2'], $this->headers());

        $response->assertStatus(200);
        $this->assertEquals('title 2', $response->json()['title']);
    }

    public function test_rejects_null_for_title(): void
    {
        $created = $this->createBook();
        $key = $created['id'];

        $response = $this->patchJson('/books/'.$key, ['title' => null], $this->headers());

        $response->assertStatus(400);
    }

    public function test_deletes_a_book(): void
    {
        $created = $this->createBook();
        $key = $created['id'];

        $response = $this->deleteJson('/books/'.$key, [], $this->headers());

        $response->assertStatus(204);
        $this->getJson('/books/'.$key, $this->headers())->assertStatus(404);
    }
}
