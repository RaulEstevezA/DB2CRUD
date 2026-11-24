package com.example.document;

import org.springframework.data.mongodb.core.mapping.Field;
import java.time.Instant;

/** Embedded value written by Model2DB from Order. Review it before using it. */
public class Customer {
    private Double id;

    private String email;

    @Field("full_name")
    private String fullName;

    private String phone;

    @Field("shipping_address")
    private Address shippingAddress;

    @Field("created_at")
    private Instant createdAt;

    public Double getId() {
        return id;
    }

    public void setId(Double id) {
        this.id = id;
    }

    public String getEmail() {
        return email;
    }

    public void setEmail(String email) {
        this.email = email;
    }

    public String getFullName() {
        return fullName;
    }

    public void setFullName(String fullName) {
        this.fullName = fullName;
    }

    public String getPhone() {
        return phone;
    }

    public void setPhone(String phone) {
        this.phone = phone;
    }

    public Address getShippingAddress() {
        return shippingAddress;
    }

    public void setShippingAddress(Address shippingAddress) {
        this.shippingAddress = shippingAddress;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(Instant createdAt) {
        this.createdAt = createdAt;
    }
}
