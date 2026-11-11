package com.example.api.service;

import java.util.Optional;
import java.util.function.Function;

import com.example.api.common.ApiException;
import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.dto.CategoryCreate;
import com.example.api.dto.CategoryUpdate;
import com.example.api.model.Category;
import com.example.api.repository.CategoryRepository;
import org.springframework.stereotype.Service;

/** Rules of categories: what each operation checks and changes. */
@Service
public class CategoryService {

    private final CategoryRepository repository;

    public CategoryService(CategoryRepository repository) {
        this.repository = repository;
    }

    private Category find(Long key) {
        return repository.get(key).orElseThrow(() -> ApiException.notFound("category"));
    }

    /** A reference must point to a stored item. */
    private static <K> void require(Function<K, Optional<?>> lookup, K key, String field, String model) {
        if (key != null && lookup.apply(key).isEmpty()) {
            throw ApiException.invalid(field, "No " + model + " has this key");
        }
    }

    private void checkReferences(Category item) {
        require(repository::get, item.getParentId(), "parentId", "Category");
    }

    private static void rejectNull(boolean sent, Object value, String field) {
        if (sent && value == null) {
            throw ApiException.invalid(field, "must not be null");
        }
    }

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private void apply(Category item, CategoryCreate data) {
        item.setName(data.getName());
        item.setParentId(data.getParentId());
    }

    private void applyChanges(Category item, CategoryUpdate data) {
        rejectNull(data.has("name"), data.getName(), "name");
        if (data.has("name")) {
            item.setName(data.getName());
        }
        if (data.has("parentId")) {
            item.setParentId(data.getParentId());
        }
    }

    /** List categories. */
    public ListResult<Category> listCategories(ListQuery query) {
        return repository.list(query);
    }

    /** Get a category. */
    public Category getCategory(Long key) {
        return find(key);
    }

    /** Create a category. */
    public Category createCategory(CategoryCreate data) {
        Category item = new Category();
        apply(item, data);
        checkReferences(item);
        return repository.add(item);
    }

    /** Replace a category: every field the client may send takes the value of the body. */
    public Category replaceCategory(Long key, CategoryCreate data) {
        Category item = find(key);
        apply(item, data);
        checkReferences(item);
        return repository.update(item);
    }

    /** Update part of a category: only the fields in the body change. */
    public Category updateCategory(Long key, CategoryUpdate data) {
        Category item = find(key);
        applyChanges(item, data);
        checkReferences(item);
        return repository.update(item);
    }

    /** Delete a category. */
    public void deleteCategory(Long key) {
        find(key);
        repository.delete(key);
    }
}
