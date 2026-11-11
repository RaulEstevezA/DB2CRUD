package com.example.api.dto;

import com.example.api.common.Payload;
import jakarta.validation.constraints.NotNull;

/** Body of a request that creates or replaces a product. */
public class ProductCreate extends Payload {

    @NotNull
    private String sku;

    @NotNull
    private String name;

    private String description;

    @NotNull
    private Double price;

    @NotNull
    private Double stock;

    @NotNull
    private Boolean active;

    public String getSku() {
        return sku;
    }

    public void setSku(String sku) {
        mark("sku");
        this.sku = sku;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        mark("name");
        this.name = name;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        mark("description");
        this.description = description;
    }

    public Double getPrice() {
        return price;
    }

    public void setPrice(Double price) {
        mark("price");
        this.price = price;
    }

    public Double getStock() {
        return stock;
    }

    public void setStock(Double stock) {
        mark("stock");
        this.stock = stock;
    }

    public Boolean getActive() {
        return active;
    }

    public void setActive(Boolean active) {
        mark("active");
        this.active = active;
    }
}
