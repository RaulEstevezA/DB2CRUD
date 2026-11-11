package com.example.api.dto;

import com.example.api.common.Payload;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/** Body of a request that creates or replaces a category. */
public class CategoryCreate extends Payload {

    @NotNull
    @Size(min = 1, max = 80)
    private String name;

    private Long parentId;

    public String getName() {
        return name;
    }

    public void setName(String name) {
        mark("name");
        this.name = name;
    }

    public Long getParentId() {
        return parentId;
    }

    public void setParentId(Long parentId) {
        mark("parentId");
        this.parentId = parentId;
    }
}
