package com.example.api.service;

import java.util.Optional;
import java.util.function.Function;

import com.example.api.common.ApiException;
import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.dto.ItemCreate;
import com.example.api.dto.ItemUpdate;
import com.example.api.model.Item;
import com.example.api.repository.CategoryRepository;
import com.example.api.repository.ItemRepository;
import org.springframework.stereotype.Service;

/** Rules of items: what each operation checks and changes. */
@Service
public class ItemService {

    private final ItemRepository repository;
    private final CategoryRepository categoryRepository;

    public ItemService(ItemRepository repository, CategoryRepository categoryRepository) {
        this.repository = repository;
        this.categoryRepository = categoryRepository;
    }

    private Item find(Long key) {
        return repository.get(key).orElseThrow(() -> ApiException.notFound("item"));
    }

    /** A reference must point to a stored item. */
    private static <K> void require(Function<K, Optional<?>> lookup, K key, String field, String model) {
        if (key != null && lookup.apply(key).isEmpty()) {
            throw ApiException.invalid(field, "No " + model + " has this key");
        }
    }

    private void checkReferences(Item item) {
        require(categoryRepository::get, item.getCategoryId(), "categoryId", "Category");
    }

    private static void rejectNull(boolean sent, Object value, String field) {
        if (sent && value == null) {
            throw ApiException.invalid(field, "must not be null");
        }
    }

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private void apply(Item item, ItemCreate data) {
        item.setName(data.getName());
        item.setPrice(data.getPrice());
        item.setSupplierEmail(data.getSupplierEmail());
        item.setCategoryId(data.getCategoryId());
        item.setStock(data.getStock());
    }

    private void applyChanges(Item item, ItemUpdate data) {
        rejectNull(data.has("name"), data.getName(), "name");
        rejectNull(data.has("price"), data.getPrice(), "price");
        rejectNull(data.has("supplierEmail"), data.getSupplierEmail(), "supplierEmail");
        rejectNull(data.has("categoryId"), data.getCategoryId(), "categoryId");
        rejectNull(data.has("stock"), data.getStock(), "stock");
        if (data.has("name")) {
            item.setName(data.getName());
        }
        if (data.has("price")) {
            item.setPrice(data.getPrice());
        }
        if (data.has("supplierEmail")) {
            item.setSupplierEmail(data.getSupplierEmail());
        }
        if (data.has("categoryId")) {
            item.setCategoryId(data.getCategoryId());
        }
        if (data.has("stock")) {
            item.setStock(data.getStock());
        }
    }

    /** List items. */
    public ListResult<Item> listItems(ListQuery query) {
        return repository.list(query);
    }

    /** Get an item. */
    public Item getItem(Long key) {
        return find(key);
    }

    /** Create an item. */
    public Item createItem(ItemCreate data) {
        Item item = new Item();
        apply(item, data);
        checkReferences(item);
        return repository.add(item);
    }

    /** Replace an item: every field the client may send takes the value of the body. */
    public Item replaceItem(Long key, ItemCreate data) {
        Item item = find(key);
        apply(item, data);
        checkReferences(item);
        return repository.update(item);
    }

    /** Update part of an item: only the fields in the body change. */
    public Item updateItem(Long key, ItemUpdate data) {
        Item item = find(key);
        applyChanges(item, data);
        checkReferences(item);
        return repository.update(item);
    }

    /** Delete an item. */
    public void deleteItem(Long key) {
        find(key);
        repository.delete(key);
    }
}
