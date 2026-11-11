package com.example.api.controller;

import java.util.HashMap;
import java.util.Map;

import com.example.api.common.ListQuery;
import com.example.api.common.PageResponse;
import com.example.api.dto.OrderCreate;
import com.example.api.dto.OrderResponse;
import com.example.api.dto.OrderUpdate;
import com.example.api.service.OrderService;
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

/** Routes of orders: HTTP in, service calls, HTTP out. */
@RestController
public class OrderController {

    private final OrderService service;

    public OrderController(OrderService service) {
        this.service = service;
    }

    /** List orders. */
    @GetMapping("/orders")
    public ResponseEntity<PageResponse<OrderResponse>> listOrders(@RequestParam(defaultValue = "1") @Min(1) int page, @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        Map<String, Object> filters = new HashMap<>();
        var result = service.listOrders(ListQuery.of(filters, null, (page - 1) * size, size));
        return ResponseEntity.status(200).body(new PageResponse<>(result.items().stream().map(OrderResponse::from).toList(), result.total(), page, size));
    }

    /** Get an order. */
    @GetMapping("/orders/{id}")
    public ResponseEntity<OrderResponse> getOrder(@PathVariable("id") Long key) {
        return ResponseEntity.status(200).body(OrderResponse.from(service.getOrder(key)));
    }

    /** Create an order. */
    @PostMapping("/orders")
    public ResponseEntity<OrderResponse> createOrder(@Valid @RequestBody OrderCreate data) {
        return ResponseEntity.status(201).body(OrderResponse.from(service.createOrder(data)));
    }

    /** Replace an order. */
    @PutMapping("/orders/{id}")
    public ResponseEntity<OrderResponse> replaceOrder(@PathVariable("id") Long key, @Valid @RequestBody OrderCreate data) {
        return ResponseEntity.status(200).body(OrderResponse.from(service.replaceOrder(key, data)));
    }

    /** Update part of an order. */
    @PatchMapping("/orders/{id}")
    public ResponseEntity<OrderResponse> updateOrder(@PathVariable("id") Long key, @Valid @RequestBody OrderUpdate data) {
        return ResponseEntity.status(200).body(OrderResponse.from(service.updateOrder(key, data)));
    }

    /** Delete an order. */
    @DeleteMapping("/orders/{id}")
    public ResponseEntity<Void> deleteOrder(@PathVariable("id") Long key) {
        service.deleteOrder(key);
        return ResponseEntity.status(204).build();
    }
}
