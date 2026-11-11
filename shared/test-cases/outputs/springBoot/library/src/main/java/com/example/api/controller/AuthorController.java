package com.example.api.controller;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import com.example.api.common.ListQuery;
import com.example.api.common.PageResponse;
import com.example.api.dto.AuthorCreate;
import com.example.api.dto.AuthorResponse;
import com.example.api.dto.AuthorUpdate;
import com.example.api.service.AuthorService;
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

/** Routes of authors: HTTP in, service calls, HTTP out. */
@RestController
public class AuthorController {

    private final AuthorService service;

    public AuthorController(AuthorService service) {
        this.service = service;
    }

    /** List authors. */
    @GetMapping("/authors")
    public ResponseEntity<PageResponse<AuthorResponse>> listAuthors(@RequestParam(defaultValue = "1") @Min(1) int page, @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        Map<String, Object> filters = new HashMap<>();
        var result = service.listAuthors(ListQuery.of(filters, null, (page - 1) * size, size));
        return ResponseEntity.status(200).body(new PageResponse<>(result.items().stream().map(AuthorResponse::from).toList(), result.total(), page, size));
    }

    /** Get an author. */
    @GetMapping("/authors/{id}")
    public ResponseEntity<AuthorResponse> getAuthor(@PathVariable("id") UUID key) {
        return ResponseEntity.status(200).body(AuthorResponse.from(service.getAuthor(key)));
    }

    /** Create an author. */
    @PostMapping("/authors")
    public ResponseEntity<AuthorResponse> createAuthor(@Valid @RequestBody AuthorCreate data) {
        return ResponseEntity.status(201).body(AuthorResponse.from(service.createAuthor(data)));
    }

    /** Replace an author. */
    @PutMapping("/authors/{id}")
    public ResponseEntity<AuthorResponse> replaceAuthor(@PathVariable("id") UUID key, @Valid @RequestBody AuthorCreate data) {
        return ResponseEntity.status(200).body(AuthorResponse.from(service.replaceAuthor(key, data)));
    }

    /** Update part of an author. */
    @PatchMapping("/authors/{id}")
    public ResponseEntity<AuthorResponse> updateAuthor(@PathVariable("id") UUID key, @Valid @RequestBody AuthorUpdate data) {
        return ResponseEntity.status(200).body(AuthorResponse.from(service.updateAuthor(key, data)));
    }

    /** Delete an author. */
    @DeleteMapping("/authors/{id}")
    public ResponseEntity<Void> deleteAuthor(@PathVariable("id") UUID key) {
        service.deleteAuthor(key);
        return ResponseEntity.status(204).build();
    }
}
