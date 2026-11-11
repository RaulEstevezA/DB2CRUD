package com.example.api.controller;

import java.util.HashMap;
import java.util.Map;

import com.example.api.common.ListQuery;
import com.example.api.common.PageResponse;
import com.example.api.dto.CategoryCreate;
import com.example.api.dto.CategoryResponse;
import com.example.api.dto.CategoryUpdate;
import com.example.api.service.CategoryService;
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

/** Routes of categories: HTTP in, service calls, HTTP out. */
@RestController
public class CategoryController {

    private final CategoryService service;

    public CategoryController(CategoryService service) {
        this.service = service;
    }

    /** List categories. */
    @GetMapping("/categories")
    public ResponseEntity<PageResponse<CategoryResponse>> listCategories(@RequestParam(defaultValue = "1") @Min(1) int page, @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        Map<String, Object> filters = new HashMap<>();
        var result = service.listCategories(ListQuery.of(filters, null, (page - 1) * size, size));
        return ResponseEntity.status(200).body(new PageResponse<>(result.items().stream().map(CategoryResponse::from).toList(), result.total(), page, size));
    }

    /** Get a category. */
    @GetMapping("/categories/{id}")
    public ResponseEntity<CategoryResponse> getCategory(@PathVariable("id") Long key) {
        return ResponseEntity.status(200).body(CategoryResponse.from(service.getCategory(key)));
    }

    /** Create a category. */
    @PostMapping("/categories")
    public ResponseEntity<CategoryResponse> createCategory(@Valid @RequestBody CategoryCreate data) {
        return ResponseEntity.status(201).body(CategoryResponse.from(service.createCategory(data)));
    }

    /** Replace a category. */
    @PutMapping("/categories/{id}")
    public ResponseEntity<CategoryResponse> replaceCategory(@PathVariable("id") Long key, @Valid @RequestBody CategoryCreate data) {
        return ResponseEntity.status(200).body(CategoryResponse.from(service.replaceCategory(key, data)));
    }

    /** Update part of a category. */
    @PatchMapping("/categories/{id}")
    public ResponseEntity<CategoryResponse> updateCategory(@PathVariable("id") Long key, @Valid @RequestBody CategoryUpdate data) {
        return ResponseEntity.status(200).body(CategoryResponse.from(service.updateCategory(key, data)));
    }

    /** Delete a category. */
    @DeleteMapping("/categories/{id}")
    public ResponseEntity<Void> deleteCategory(@PathVariable("id") Long key) {
        service.deleteCategory(key);
        return ResponseEntity.status(204).build();
    }
}
