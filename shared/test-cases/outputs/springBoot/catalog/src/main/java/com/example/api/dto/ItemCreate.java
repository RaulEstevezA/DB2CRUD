package com.example.api.dto;

import java.math.BigDecimal;

import com.example.api.common.Payload;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/** Body of a request that creates or replaces an item. */
public class ItemCreate extends Payload {

    @NotNull
    @Size(min = 3, max = 120)
    private String name;

    @NotNull
    @DecimalMin("0")
    private BigDecimal price;

    @NotNull
    @Email
    private String supplierEmail;

    @NotNull
    private Long categoryId;

    @NotNull
    @DecimalMin("0")
    private Integer stock;

    public String getName() {
        return name;
    }

    public void setName(String name) {
        mark("name");
        this.name = name;
    }

    public BigDecimal getPrice() {
        return price;
    }

    public void setPrice(BigDecimal price) {
        mark("price");
        this.price = price;
    }

    public String getSupplierEmail() {
        return supplierEmail;
    }

    public void setSupplierEmail(String supplierEmail) {
        mark("supplierEmail");
        this.supplierEmail = supplierEmail;
    }

    public Long getCategoryId() {
        return categoryId;
    }

    public void setCategoryId(Long categoryId) {
        mark("categoryId");
        this.categoryId = categoryId;
    }

    public Integer getStock() {
        return stock;
    }

    public void setStock(Integer stock) {
        mark("stock");
        this.stock = stock;
    }
}
