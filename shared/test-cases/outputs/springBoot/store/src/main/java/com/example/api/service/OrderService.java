package com.example.api.service;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import java.util.function.Function;

import com.example.api.common.ApiException;
import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.dto.OrderCreate;
import com.example.api.dto.OrderUpdate;
import com.example.api.model.Order;
import com.example.api.repository.CustomerRepository;
import com.example.api.repository.OrderRepository;
import com.example.api.repository.ProductRepository;
import org.springframework.stereotype.Service;

/** Rules of orders: what each operation checks and changes. */
@Service
public class OrderService {

    private final OrderRepository repository;
    private final CustomerRepository customerRepository;
    private final ProductRepository productRepository;

    public OrderService(OrderRepository repository, CustomerRepository customerRepository, ProductRepository productRepository) {
        this.repository = repository;
        this.customerRepository = customerRepository;
        this.productRepository = productRepository;
    }

    private Order find(Long key) {
        return repository.get(key).orElseThrow(() -> ApiException.notFound("order"));
    }

    /** A reference must point to a stored item. */
    private static <K> void require(Function<K, Optional<?>> lookup, K key, String field, String model) {
        if (key != null && lookup.apply(key).isEmpty()) {
            throw ApiException.invalid(field, "No " + model + " has this key");
        }
    }

    private void checkReferences(Order item) {
        require(customerRepository::get, item.getCustomerId(), "customerId", "Customer");
        if (item.getLines() != null) {
            for (var item0 : item.getLines()) {
                require(productRepository::get, item0.productId(), "lines.productId", "Product");
            }
        }
    }

    private static void rejectNull(boolean sent, Object value, String field) {
        if (sent && value == null) {
            throw ApiException.invalid(field, "must not be null");
        }
    }

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private void apply(Order item, OrderCreate data) {
        item.setCustomerId(data.getCustomerId());
        item.setLines(data.getLines());
        item.setStatus(data.getStatus());
        item.setTotal(data.getTotal());
        item.setNotes(data.getNotes());
    }

    private void applyChanges(Order item, OrderUpdate data) {
        rejectNull(data.has("customerId"), data.getCustomerId(), "customerId");
        rejectNull(data.has("lines"), data.getLines(), "lines");
        rejectNull(data.has("status"), data.getStatus(), "status");
        rejectNull(data.has("total"), data.getTotal(), "total");
        if (data.has("customerId")) {
            item.setCustomerId(data.getCustomerId());
        }
        if (data.has("lines")) {
            item.setLines(data.getLines());
        }
        if (data.has("status")) {
            item.setStatus(data.getStatus());
        }
        if (data.has("total")) {
            item.setTotal(data.getTotal());
        }
        if (data.has("notes")) {
            item.setNotes(data.getNotes());
        }
    }

    /** List orders. */
    public ListResult<Order> listOrders(ListQuery query) {
        return repository.list(query);
    }

    /** Get an order. */
    public Order getOrder(Long key) {
        return find(key);
    }

    /** Create an order. */
    public Order createOrder(OrderCreate data) {
        Order item = new Order();
        apply(item, data);
        checkReferences(item);
        item.setCreatedAt(OffsetDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.MICROS));
        item.setUpdatedAt(OffsetDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.MICROS));
        return repository.add(item);
    }

    /** Replace an order: every field the client may send takes the value of the body. */
    public Order replaceOrder(Long key, OrderCreate data) {
        Order item = find(key);
        apply(item, data);
        checkReferences(item);
        item.setUpdatedAt(OffsetDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.MICROS));
        return repository.update(item);
    }

    /** Update part of an order: only the fields in the body change. */
    public Order updateOrder(Long key, OrderUpdate data) {
        Order item = find(key);
        applyChanges(item, data);
        checkReferences(item);
        item.setUpdatedAt(OffsetDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.MICROS));
        return repository.update(item);
    }

    /** Delete an order. */
    public void deleteOrder(Long key) {
        find(key);
        repository.delete(key);
    }
}
