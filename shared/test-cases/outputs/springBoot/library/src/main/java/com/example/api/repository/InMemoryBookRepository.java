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
import com.example.api.model.Book;
import org.springframework.stereotype.Repository;

/** Keeps books in memory: they are lost when the application stops. Use it to try the API. */
@Repository
public class InMemoryBookRepository implements BookRepository {

    private final Map<UUID, Book> items = new ConcurrentHashMap<>();

    /** The value of a field by its JSON name, for filters and sorting. */
    private static Object value(Book item, String field) {
        return switch (field) {
            case "id" -> item.getId();
            case "title" -> item.getTitle();
            case "isbn" -> item.getIsbn();
            case "authorId" -> item.getAuthorId();
            case "genre" -> item.getGenre();
            case "pages" -> item.getPages();
            case "published" -> item.getPublished();
            case "available" -> item.getAvailable();
            default -> null;
        };
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    @Override
    public ListResult<Book> list(ListQuery query) {
        List<Book> found = new ArrayList<>(items.values().stream()
                .filter(item -> query.filters().entrySet().stream().allMatch(filter -> Objects.equals(value(item, filter.getKey()), filter.getValue())))
                .toList());
        if (query.sortField() != null) {
            Comparator<Book> order = Comparator.comparing(item -> (Comparable) value(item, query.sortField()));
            List<Book> sorted = new ArrayList<>(found.stream().filter(item -> value(item, query.sortField()) != null).toList());
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
    public Optional<Book> get(UUID key) {
        return Optional.ofNullable(items.get(key));
    }

    @Override
    public Book add(Book item) {
        item.setId(UUID.randomUUID());
        items.put(item.getId(), item);
        return item;
    }

    @Override
    public Book update(Book item) {
        items.put(item.getId(), item);
        return item;
    }

    @Override
    public void delete(UUID key) {
        items.remove(key);
    }
}
