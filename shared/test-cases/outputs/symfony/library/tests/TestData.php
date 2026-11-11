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
     * A valid body to create an author, with the items it refers to created first.
     *
     * @return array<string, mixed>
     */
    protected function authorPayload(int $variant = 0): array
    {
        $body = $variant === 0 ? ['name' => 'name 1', 'email' => 'user1@example.com', 'born' => '2024-01-15'] : ['name' => 'name 2', 'email' => 'user2@example.com', 'born' => '2024-01-16'];

        return $body;
    }

    /**
     * Creates an author and returns it as the API answers.
     *
     * @return array<string, mixed>
     */
    protected function createAuthor(int $variant = 0): array
    {
        $response = $this->postJson('/authors', $this->authorPayload($variant), $this->headers());
        $response->assertStatus(201);

        return $response->json();
    }

    /**
     * A valid body to create a book, with the items it refers to created first.
     *
     * @return array<string, mixed>
     */
    protected function bookPayload(int $variant = 0): array
    {
        $body = $variant === 0 ? ['title' => 'title 1', 'isbn' => '0000000000000', 'authorId' => null, 'genre' => 'novel', 'pages' => 1, 'published' => '2024-01-15', 'available' => true] : ['title' => 'title 2', 'isbn' => '0000000000000', 'authorId' => null, 'genre' => 'essay', 'pages' => 2, 'published' => '2024-01-16', 'available' => false];
        $body['authorId'] = $this->createAuthor()['id'];

        return $body;
    }

    /**
     * Creates a book and returns it as the API answers.
     *
     * @return array<string, mixed>
     */
    protected function createBook(int $variant = 0): array
    {
        $response = $this->postJson('/books', $this->bookPayload($variant), $this->headers());
        $response->assertStatus(201);

        return $response->json();
    }
}
