package com.example.api.common;

import jakarta.validation.ConstraintViolationException;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

/** Answers every error with the common format and the status of openapi.yaml. */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger LOG = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    private static ResponseEntity<ErrorResponse> answer(HttpStatus status, String code, String message, List<ErrorResponse.Detail> details) {
        return ResponseEntity.status(status).body(ErrorResponse.of(code, message, details));
    }

    @ExceptionHandler(ApiException.class)
    ResponseEntity<ErrorResponse> api(ApiException error) {
        return answer(error.getStatus(), error.getCode(), error.getMessage(), error.getDetails());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<ErrorResponse> invalidBody(MethodArgumentNotValidException error) {
        List<ErrorResponse.Detail> details = error.getBindingResult().getFieldErrors().stream()
                .map(item -> new ErrorResponse.Detail(item.getField(), item.getDefaultMessage()))
                .toList();
        return answer(HttpStatus.BAD_REQUEST, "validation_error", "The request is not valid", details);
    }

    @ExceptionHandler({HandlerMethodValidationException.class, ConstraintViolationException.class, MethodArgumentTypeMismatchException.class})
    ResponseEntity<ErrorResponse> invalidParameter(Exception error) {
        return answer(HttpStatus.BAD_REQUEST, "validation_error", "The request is not valid", List.of());
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    ResponseEntity<ErrorResponse> unreadable(HttpMessageNotReadableException error) {
        return answer(HttpStatus.BAD_REQUEST, "validation_error", "The body is not valid JSON, has a value of the wrong type or an unknown field", List.of());
    }

    @ExceptionHandler(NoResourceFoundException.class)
    ResponseEntity<ErrorResponse> noRoute(NoResourceFoundException error) {
        return answer(HttpStatus.NOT_FOUND, "not_found", "No route matches this request", List.of());
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    ResponseEntity<ErrorResponse> wrongMethod(HttpRequestMethodNotSupportedException error) {
        return answer(HttpStatus.METHOD_NOT_ALLOWED, "method_not_allowed", "This path does not accept this method", List.of());
    }

    @ExceptionHandler(NotImplementedException.class)
    ResponseEntity<ErrorResponse> notImplemented(NotImplementedException error) {
        return answer(HttpStatus.NOT_IMPLEMENTED, "not_implemented", error.getMessage(), List.of());
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<ErrorResponse> unexpected(Exception error) throws Exception {
        LOG.error("Unexpected error", error);
        return answer(HttpStatus.INTERNAL_SERVER_ERROR, "internal_error", "Something went wrong on the server", List.of());
    }
}
