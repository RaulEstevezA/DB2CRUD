package com.example.api.common;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** The body of every error: {"error": {"code", "message", "details"}}. */
public record ErrorResponse(Body error) {

    public record Body(String code, String message, @JsonInclude(JsonInclude.Include.NON_EMPTY) List<Detail> details) {
    }

    /** Where the request is wrong and why. */
    public record Detail(String field, String message) {
    }

    public static ErrorResponse of(String code, String message, List<Detail> details) {
        return new ErrorResponse(new Body(code, message, details));
    }
}
