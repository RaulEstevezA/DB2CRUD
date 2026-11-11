package com.example.api.controller;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import com.example.api.common.ListQuery;
import com.example.api.common.PageResponse;
import com.example.api.dto.BookCreate;
import com.example.api.dto.BookResponse;
import com.example.api.dto.BookUpdate;
import com.example.api.service.BookService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Routes of books: HTTP in, service calls, HTTP out. */
@RestController
public class BookController {

    private final BookService service;

    public BookController(BookService service) {
        this.service = service;
    }

    /** List books. */
    @GetMapping("/books")
    public ResponseEntity<PageResponse<BookResponse>> listBooks(@RequestParam(defaultValue = "1") @Min(1) int page, @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        Map<String, Object> filters = new HashMap<>();
        var result = service.listBooks(ListQuery.of(filters, null, (page - 1) * size, size));
        return ResponseEntity.status(200).body(new PageResponse<>(result.items().stream().map(BookResponse::from).toList(), result.total(), page, size));
    }

    /** Get a book. */
    @GetMapping("/books/{id}")
    public ResponseEntity<BookResponse> getBook(@PathVariable("id") UUID key) {
        return ResponseEntity.status(200).body(BookResponse.from(service.getBook(key)));
    }

    /** Create a book. */
    @PostMapping("/books")
    public ResponseEntity<BookResponse> createBook(@Valid @RequestBody BookCreate data) {
        return ResponseEntity.status(201).body(BookResponse.from(service.createBook(data)));
    }

    /** Replace a book. */
    @PutMapping("/books/{id}")
    public ResponseEntity<BookResponse> replaceBook(@PathVariable("id") UUID key, @Valid @RequestBody BookCreate data) {
        return ResponseEntity.status(200).body(BookResponse.from(service.replaceBook(key, data)));
    }

    /** Update part of a book. */
    @PatchMapping("/books/{id}")
    public ResponseEntity<BookResponse> updateBook(@PathVariable("id") UUID key, @Valid @RequestBody BookUpdate data) {
        return ResponseEntity.status(200).body(BookResponse.from(service.updateBook(key, data)));
    }

    /** Delete a book. */
    @DeleteMapping("/books/{id}")
    public ResponseEntity<Void> deleteBook(@PathVariable("id") UUID key) {
        service.deleteBook(key);
        return ResponseEntity.status(204).build();
    }
}
