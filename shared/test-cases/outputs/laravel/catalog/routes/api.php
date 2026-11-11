<?php

use App\Http\Controllers\CategoryController;
use App\Http\Controllers\ItemController;
use Illuminate\Support\Facades\Route;

// Every route of the API, with its protection. The contract is in openapi.yaml.

// Categories
Route::get('/categories', [CategoryController::class, 'listCategories']);
Route::get('/categories/{id}', [CategoryController::class, 'getCategory']);
Route::post('/categories', [CategoryController::class, 'createCategory']);
Route::put('/categories/{id}', [CategoryController::class, 'replaceCategory']);
Route::patch('/categories/{id}', [CategoryController::class, 'updateCategory']);
Route::delete('/categories/{id}', [CategoryController::class, 'deleteCategory']);

// Items
Route::get('/items', [ItemController::class, 'listItems']);
Route::get('/items/{id}', [ItemController::class, 'getItem']);
Route::post('/items', [ItemController::class, 'createItem']);
Route::put('/items/{id}', [ItemController::class, 'replaceItem']);
Route::patch('/items/{id}', [ItemController::class, 'updateItem']);
Route::delete('/items/{id}', [ItemController::class, 'deleteItem']);
