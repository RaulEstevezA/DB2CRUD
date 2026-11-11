package com.example.api.repository;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.model.Author;
import org.springframework.stereotype.Repository;

/** Keeps authors in memory: they are lost when the application stops. Use it to try the API. */
@Repository
public class InMemoryAuthorRepository implements AuthorRepository {

    private final Map<UUID, Author> items = new ConcurrentHashMap<>();

    /** The value of a field by its JSON name, for filters and sorting. */
    private static Object value(Author item, String field) {
        return switch (field) {
            case "id" -> item.getId();
            case "name" -> item.getName();
            case "email" -> item.getEmail();
            case "born" -> item.getBorn();
            default -> null;
        };
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    @Override
    public ListResult<Author> list(ListQuery query) {
        List<Author> found = new ArrayList<>(items.values().stream()
                .filter(item -> query.filters().entrySet().stream().allMatch(filter -> Objects.equals(value(item, filter.getKey()), filter.getValue())))
                .toList());
        if (query.sortField() != null) {
            Comparator<Author> order = Comparator.comparing(item -> (Comparable) value(item, query.sortField()));
            List<Author> sorted = new ArrayList<>(found.stream().filter(item -> value(item, query.sortField()) != null).toList());
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
    public Optional<Author> get(UUID key) {
        return Optional.ofNullable(items.get(key));
    }

    @Override
    public Author add(Author item) {
        item.setId(UUID.randomUUID());
        items.put(item.getId(), item);
        return item;
    }

    @Override
    public Author update(Author item) {
        items.put(item.getId(), item);
        return item;
    }

    @Override
    public void delete(UUID key) {
        items.remove(key);
    }
}
