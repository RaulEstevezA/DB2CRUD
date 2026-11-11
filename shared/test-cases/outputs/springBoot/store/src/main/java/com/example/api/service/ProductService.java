package com.example.api.service;

import com.example.api.common.ApiException;
import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.dto.ProductCreate;
import com.example.api.dto.ProductUpdate;
import com.example.api.model.Product;
import com.example.api.repository.ProductRepository;
import org.springframework.stereotype.Service;

/** Rules of products: what each operation checks and changes. */
@Service
public class ProductService {

    private final ProductRepository repository;

    public ProductService(ProductRepository repository) {
        this.repository = repository;
    }

    private Product find(Long key) {
        return repository.get(key).orElseThrow(() -> ApiException.notFound("product"));
    }

    private static void rejectNull(boolean sent, Object value, String field) {
        if (sent && value == null) {
            throw ApiException.invalid(field, "must not be null");
        }
    }

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private void apply(Product item, ProductCreate data) {
        rejectNull(data.has("description"), data.getDescription(), "description");
        item.setSku(data.getSku());
        item.setName(data.getName());
        item.setDescription(data.getDescription());
        item.setPrice(data.getPrice());
        item.setStock(data.getStock());
        item.setActive(data.getActive());
    }

    private void applyChanges(Product item, ProductUpdate data) {
        rejectNull(data.has("sku"), data.getSku(), "sku");
        rejectNull(data.has("name"), data.getName(), "name");
        rejectNull(data.has("description"), data.getDescription(), "description");
        rejectNull(data.has("price"), data.getPrice(), "price");
        rejectNull(data.has("stock"), data.getStock(), "stock");
        rejectNull(data.has("active"), data.getActive(), "active");
        if (data.has("sku")) {
            item.setSku(data.getSku());
        }
        if (data.has("name")) {
            item.setName(data.getName());
        }
        if (data.has("description")) {
            item.setDescription(data.getDescription());
        }
        if (data.has("price")) {
            item.setPrice(data.getPrice());
        }
        if (data.has("stock")) {
            item.setStock(data.getStock());
        }
        if (data.has("active")) {
            item.setActive(data.getActive());
        }
    }

    /** List products. */
    public ListResult<Product> listProducts(ListQuery query) {
        return repository.list(query);
    }

    /** Get a product. */
    public Product getProduct(Long key) {
        return find(key);
    }

    /** Create a product. */
    public Product createProduct(ProductCreate data) {
        Product item = new Product();
        apply(item, data);
        return repository.add(item);
    }

    /** Replace a product: every field the client may send takes the value of the body. */
    public Product replaceProduct(Long key, ProductCreate data) {
        Product item = find(key);
        apply(item, data);
        return repository.update(item);
    }

    /** Update part of a product: only the fields in the body change. */
    public Product updateProduct(Long key, ProductUpdate data) {
        Product item = find(key);
        applyChanges(item, data);
        return repository.update(item);
    }

    /** Delete a product. */
    public void deleteProduct(Long key) {
        find(key);
        repository.delete(key);
    }
}
