package com.example.api.controller;

import java.util.HashMap;
import java.util.Map;

import com.example.api.common.ListQuery;
import com.example.api.common.PageResponse;
import com.example.api.dto.ItemCreate;
import com.example.api.dto.ItemResponse;
import com.example.api.dto.ItemUpdate;
import com.example.api.service.ItemService;
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

/** Routes of items: HTTP in, service calls, HTTP out. */
@RestController
public class ItemController {

    private final ItemService service;

    public ItemController(ItemService service) {
        this.service = service;
    }

    /** List items. */
    @GetMapping("/items")
    public ResponseEntity<PageResponse<ItemResponse>> listItems(@RequestParam(defaultValue = "1") @Min(1) int page, @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        Map<String, Object> filters = new HashMap<>();
        var result = service.listItems(ListQuery.of(filters, null, (page - 1) * size, size));
        return ResponseEntity.status(200).body(new PageResponse<>(result.items().stream().map(ItemResponse::from).toList(), result.total(), page, size));
    }

    /** Get an item. */
    @GetMapping("/items/{id}")
    public ResponseEntity<ItemResponse> getItem(@PathVariable("id") Long key) {
        return ResponseEntity.status(200).body(ItemResponse.from(service.getItem(key)));
    }

    /** Create an item. */
    @PostMapping("/items")
    public ResponseEntity<ItemResponse> createItem(@Valid @RequestBody ItemCreate data) {
        return ResponseEntity.status(201).body(ItemResponse.from(service.createItem(data)));
    }

    /** Replace an item. */
    @PutMapping("/items/{id}")
    public ResponseEntity<ItemResponse> replaceItem(@PathVariable("id") Long key, @Valid @RequestBody ItemCreate data) {
        return ResponseEntity.status(200).body(ItemResponse.from(service.replaceItem(key, data)));
    }

    /** Update part of an item. */
    @PatchMapping("/items/{id}")
    public ResponseEntity<ItemResponse> updateItem(@PathVariable("id") Long key, @Valid @RequestBody ItemUpdate data) {
        return ResponseEntity.status(200).body(ItemResponse.from(service.updateItem(key, data)));
    }

    /** Delete an item. */
    @DeleteMapping("/items/{id}")
    public ResponseEntity<Void> deleteItem(@PathVariable("id") Long key) {
        service.deleteItem(key);
        return ResponseEntity.status(204).build();
    }
}
