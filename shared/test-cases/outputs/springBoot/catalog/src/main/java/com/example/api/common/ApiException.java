package com.example.api.common;

import java.util.List;
import org.springframework.http.HttpStatus;

/** An error the API answers with a status, a code and a message (see openapi.yaml). */
public class ApiException extends RuntimeException {

    private final HttpStatus status;
    private final String code;
    private final List<ErrorResponse.Detail> details;

    public ApiException(HttpStatus status, String code, String message, List<ErrorResponse.Detail> details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }

    public static ApiException invalid(String field, String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "validation_error", "The request is not valid", List.of(new ErrorResponse.Detail(field, message)));
    }

    public static ApiException notFound(String what) {
        return new ApiException(HttpStatus.NOT_FOUND, "not_found", "No " + what + " has this key", List.of());
    }

    public static ApiException conflict(String message) {
        return new ApiException(HttpStatus.CONFLICT, "conflict", message, List.of());
    }

    public HttpStatus getStatus() {
        return status;
    }

    public String getCode() {
        return code;
    }

    public List<ErrorResponse.Detail> getDetails() {
        return details;
    }
}
