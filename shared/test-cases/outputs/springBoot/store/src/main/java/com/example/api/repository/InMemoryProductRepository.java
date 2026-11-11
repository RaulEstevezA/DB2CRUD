package com.example.api.repository;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.model.Product;
import org.springframework.stereotype.Repository;

/** Keeps products in memory: they are lost when the application stops. Use it to try the API. */
@Repository
public class InMemoryProductRepository implements ProductRepository {

    private final Map<Long, Product> items = new ConcurrentHashMap<>();
    private final AtomicLong nextKey = new AtomicLong(1);

    /** The value of a field by its JSON name, for filters and sorting. */
    private static Object value(Product item, String field) {
        return switch (field) {
            case "id" -> item.getId();
            case "sku" -> item.getSku();
            case "name" -> item.getName();
            case "description" -> item.getDescription();
            case "price" -> item.getPrice();
            case "stock" -> item.getStock();
            case "active" -> item.getActive();
            default -> null;
        };
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    @Override
    public ListResult<Product> list(ListQuery query) {
        List<Product> found = new ArrayList<>(items.values().stream()
                .filter(item -> query.filters().entrySet().stream().allMatch(filter -> Objects.equals(value(item, filter.getKey()), filter.getValue())))
                .toList());
        if (query.sortField() != null) {
            Comparator<Product> order = Comparator.comparing(item -> (Comparable) value(item, query.sortField()));
            List<Product> sorted = new ArrayList<>(found.stream().filter(item -> value(item, query.sortField()) != null).toList());
            sorted.sort(query.descending() ? order.reversed() : order);
            // Items without a value go last, whatever the order
            sorted.addAll(found.stream().filter(item -> value(item, query.sortField()) == null).toList());
            found = sorted;
        }
        int from = Math.min(query.offset(), found.size());
        int to = query.limit() == null ? found.size() : Math.min(from + query.limit(), found.size());
        return new ListResult<>(found.subList(from, to), found.size());
    }

    @Override
    public Optional<Product> get(Long key) {
        return Optional.ofNullable(items.get(key));
    }

    @Override
    public Product add(Product item) {
        item.setId(nextKey.getAndIncrement());
        items.put(item.getId(), item);
        return item;
    }

    @Override
    public Product update(Product item) {
        items.put(item.getId(), item);
        return item;
    }

    @Override
    public void delete(Long key) {
        items.remove(key);
    }
}
