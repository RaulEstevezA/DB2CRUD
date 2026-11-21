package com.example.shop;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import lombok.Builder;
import lombok.Data;

public enum ProductStatus {
    DRAFT("draft"),
    LIVE("live");

    private final String value;

    ProductStatus(String value) {
        this.value = value;
    }
}

/** A customer of the shop, read with getters and filled with setters */
public class Customer {
    private Long id;
    private String email;
    private String passwordHash;
    private OffsetDateTime createdAt;

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public String getPasswordHash() { return passwordHash; }
    public void setPasswordHash(String passwordHash) { this.passwordHash = passwordHash; }
    public OffsetDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(OffsetDateTime createdAt) { this.createdAt = createdAt; }
}

public record CategoryDto(Integer id, String name) {}

@Data
@Builder
public class Product {
    private Long id;
    private String name;
    private BigDecimal price;
    private ProductStatus status;
    private String categoryName;
    private List<Integer> tagIds;
}

public class TagEntity {
    public long id;
    public String label;
}
