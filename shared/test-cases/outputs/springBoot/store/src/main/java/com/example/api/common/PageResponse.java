package com.example.api.common;

import java.util.List;

/** One page of a list, as the API returns it. */
public record PageResponse<T>(List<T> items, long total, int page, int size) {
}
