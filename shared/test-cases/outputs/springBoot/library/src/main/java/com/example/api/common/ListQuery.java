package com.example.api.common;

import java.util.Map;

/** What a list asks a repository for: equality filters by JSON field name, an order and a window. */
public record ListQuery(Map<String, Object> filters, String sortField, boolean descending, int offset, Integer limit) {

    /** `"-createdAt"` sorts by createdAt in descending order. */
    public static ListQuery of(Map<String, Object> filters, String sort, int offset, Integer limit) {
        if (sort == null || sort.isEmpty()) {
            return new ListQuery(filters, null, false, offset, limit);
        }
        boolean descending = sort.startsWith("-");
        return new ListQuery(filters, descending ? sort.substring(1) : sort, descending, offset, limit);
    }
}
