<?php

use App\Http\Controllers\AuthorController;
use App\Http\Controllers\BookController;
use Illuminate\Support\Facades\Route;

// Every route of the API, with its protection. The contract is in openapi.yaml.

// Authors
Route::get('/authors', [AuthorController::class, 'listAuthors']);
Route::get('/authors/{id}', [AuthorController::class, 'getAuthor']);
Route::post('/authors', [AuthorController::class, 'createAuthor']);
Route::put('/authors/{id}', [AuthorController::class, 'replaceAuthor']);
Route::patch('/authors/{id}', [AuthorController::class, 'updateAuthor']);
Route::delete('/authors/{id}', [AuthorController::class, 'deleteAuthor']);

// Books
Route::get('/books', [BookController::class, 'listBooks']);
Route::get('/books/{id}', [BookController::class, 'getBook']);
Route::post('/books', [BookController::class, 'createBook']);
Route::put('/books/{id}', [BookController::class, 'replaceBook']);
Route::patch('/books/{id}', [BookController::class, 'updateBook']);
Route::delete('/books/{id}', [BookController::class, 'deleteBook']);
