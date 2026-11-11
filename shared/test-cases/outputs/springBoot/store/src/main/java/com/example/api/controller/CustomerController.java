package com.example.api.controller;

import java.util.HashMap;
import java.util.Map;

import com.example.api.common.ListQuery;
import com.example.api.common.PageResponse;
import com.example.api.dto.CustomerCreate;
import com.example.api.dto.CustomerResponse;
import com.example.api.dto.CustomerUpdate;
import com.example.api.service.CustomerService;
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

/** Routes of customers: HTTP in, service calls, HTTP out. */
@RestController
public class CustomerController {

    private final CustomerService service;

    public CustomerController(CustomerService service) {
        this.service = service;
    }

    /** List customers. */
    @GetMapping("/customers")
    public ResponseEntity<PageResponse<CustomerResponse>> listCustomers(@RequestParam(defaultValue = "1") @Min(1) int page, @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        Map<String, Object> filters = new HashMap<>();
        var result = service.listCustomers(ListQuery.of(filters, null, (page - 1) * size, size));
        return ResponseEntity.status(200).body(new PageResponse<>(result.items().stream().map(CustomerResponse::from).toList(), result.total(), page, size));
    }

    /** Get a customer. */
    @GetMapping("/customers/{id}")
    public ResponseEntity<CustomerResponse> getCustomer(@PathVariable("id") Long key) {
        return ResponseEntity.status(200).body(CustomerResponse.from(service.getCustomer(key)));
    }

    /** Create a customer. */
    @PostMapping("/customers")
    public ResponseEntity<CustomerResponse> createCustomer(@Valid @RequestBody CustomerCreate data) {
        return ResponseEntity.status(201).body(CustomerResponse.from(service.createCustomer(data)));
    }

    /** Replace a customer. */
    @PutMapping("/customers/{id}")
    public ResponseEntity<CustomerResponse> replaceCustomer(@PathVariable("id") Long key, @Valid @RequestBody CustomerCreate data) {
        return ResponseEntity.status(200).body(CustomerResponse.from(service.replaceCustomer(key, data)));
    }

    /** Update part of a customer. */
    @PatchMapping("/customers/{id}")
    public ResponseEntity<CustomerResponse> updateCustomer(@PathVariable("id") Long key, @Valid @RequestBody CustomerUpdate data) {
        return ResponseEntity.status(200).body(CustomerResponse.from(service.updateCustomer(key, data)));
    }

    /** Delete a customer. */
    @DeleteMapping("/customers/{id}")
    public ResponseEntity<Void> deleteCustomer(@PathVariable("id") Long key) {
        service.deleteCustomer(key);
        return ResponseEntity.status(204).build();
    }
}
