package com.example.document;

import org.springframework.data.mongodb.core.mapping.Field;

/** Embedded value written by Model2DB from Order. Review it before using it. */
public class OrderLine {
    private Double quantity;

    @Field("unit_price")
    private Double unitPrice;

    public Double getQuantity() {
        return quantity;
    }

    public void setQuantity(Double quantity) {
        this.quantity = quantity;
    }

    public Double getUnitPrice() {
        return unitPrice;
    }

    public void setUnitPrice(Double unitPrice) {
        this.unitPrice = unitPrice;
    }
}
