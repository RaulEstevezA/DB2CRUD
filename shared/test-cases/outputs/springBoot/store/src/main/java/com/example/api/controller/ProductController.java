package com.example.api.controller;

import java.util.HashMap;
import java.util.Map;

import com.example.api.common.ListQuery;
import com.example.api.common.PageResponse;
import com.example.api.dto.ProductCreate;
import com.example.api.dto.ProductResponse;
import com.example.api.dto.ProductUpdate;
import com.example.api.service.ProductService;
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

/** Routes of products: HTTP in, service calls, HTTP out. */
@RestController
public class ProductController {

    private final ProductService service;

    public ProductController(ProductService service) {
        this.service = service;
    }

    /** List products. */
    @GetMapping("/products")
    public ResponseEntity<PageResponse<ProductResponse>> listProducts(@RequestParam(defaultValue = "1") @Min(1) int page, @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        Map<String, Object> filters = new HashMap<>();
        var result = service.listProducts(ListQuery.of(filters, null, (page - 1) * size, size));
        return ResponseEntity.status(200).body(new PageResponse<>(result.items().stream().map(ProductResponse::from).toList(), result.total(), page, size));
    }

    /** Get a product. */
    @GetMapping("/products/{id}")
    public ResponseEntity<ProductResponse> getProduct(@PathVariable("id") Long key) {
        return ResponseEntity.status(200).body(ProductResponse.from(service.getProduct(key)));
    }

    /** Create a product. */
    @PostMapping("/products")
    public ResponseEntity<ProductResponse> createProduct(@Valid @RequestBody ProductCreate data) {
        return ResponseEntity.status(201).body(ProductResponse.from(service.createProduct(data)));
    }

    /** Replace a product. */
    @PutMapping("/products/{id}")
    public ResponseEntity<ProductResponse> replaceProduct(@PathVariable("id") Long key, @Valid @RequestBody ProductCreate data) {
        return ResponseEntity.status(200).body(ProductResponse.from(service.replaceProduct(key, data)));
    }

    /** Update part of a product. */
    @PatchMapping("/products/{id}")
    public ResponseEntity<ProductResponse> updateProduct(@PathVariable("id") Long key, @Valid @RequestBody ProductUpdate data) {
        return ResponseEntity.status(200).body(ProductResponse.from(service.updateProduct(key, data)));
    }

    /** Delete a product. */
    @DeleteMapping("/products/{id}")
    public ResponseEntity<Void> deleteProduct(@PathVariable("id") Long key) {
        service.deleteProduct(key);
        return ResponseEntity.status(204).build();
    }
}
