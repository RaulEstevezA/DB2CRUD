"""Classes of the Spring Boot project that do not belong to one resource: the application class, the error format
and its global handler, list queries and pages, security (API key or JWT, with Spring Security) and the
application properties. Mirrors web/src/core/generators/frameworks/springBoot/common.ts.
"""

from ....openapi.build import GENERAL_ERROR_CODES
from ...common.testing import TEST_API_KEY, TEST_JWT_SECRET
from ...common.text import file_text, lines
from ...languages.java.java import java_class, java_doc
from .context import SpringContext, common_package, source_path


def application_class(context: SpringContext) -> str:
    return f"{java_class(context.settings['name'])}Application"


def application_file(context: SpringContext) -> dict:
    name = application_class(context)
    content = lines(
        f"package {context.base};",
        "",
        "import org.springframework.boot.SpringApplication;",
        "import org.springframework.boot.autoconfigure.SpringBootApplication;",
        "",
        java_doc('Entry point of the API: run it with "./mvnw spring-boot:run" or "mvn spring-boot:run".'),
        "@SpringBootApplication",
        f"public class {name} {{",
        "",
        "    public static void main(String[] args) {",
        f"        SpringApplication.run({name}.class, args);",
        "    }",
        "}",
    )
    return {"path": source_path(context.base, name), "content": file_text(content)}


def common_files(context: SpringContext) -> list[dict]:
    package = common_package(context)

    def file(name: str, body: list) -> dict:
        return {"path": source_path(package, name), "content": file_text(lines(f"package {package};", "", *body))}

    files: list[dict] = []
    files.extend(
        [
            file(
                "ApiException",
                [
                    "import java.util.List;",
                    "import org.springframework.http.HttpStatus;",
                    "",
                    java_doc("An error the API answers with a status, a code and a message (see openapi.yaml)."),
                    "public class ApiException extends RuntimeException {",
                    "",
                    "    private final HttpStatus status;",
                    "    private final String code;",
                    "    private final List<ErrorResponse.Detail> details;",
                    "",
                    "    public ApiException(HttpStatus status, String code, String message, List<ErrorResponse.Detail> details) {",
                    "        super(message);",
                    "        this.status = status;",
                    "        this.code = code;",
                    "        this.details = details;",
                    "    }",
                    "",
                    "    public static ApiException invalid(String field, String message) {",
                    '        return new ApiException(HttpStatus.BAD_REQUEST, "validation_error", "The request is not valid", List.of(new ErrorResponse.Detail(field, message)));',
                    "    }",
                    "",
                    "    public static ApiException notFound(String what) {",
                    '        return new ApiException(HttpStatus.NOT_FOUND, "not_found", "No " + what + " has this key", List.of());',
                    "    }",
                    "",
                    "    public static ApiException conflict(String message) {",
                    '        return new ApiException(HttpStatus.CONFLICT, "conflict", message, List.of());',
                    "    }",
                    "",
                    "    public HttpStatus getStatus() {",
                    "        return status;",
                    "    }",
                    "",
                    "    public String getCode() {",
                    "        return code;",
                    "    }",
                    "",
                    "    public List<ErrorResponse.Detail> getDetails() {",
                    "        return details;",
                    "    }",
                    "}",
                ],
            ),
            file(
                "NotImplementedException",
                [
                    java_doc("Thrown by code still to write: the API answers 501."),
                    "public class NotImplementedException extends RuntimeException {",
                    "",
                    "    public NotImplementedException(String message) {",
                    "        super(message);",
                    "    }",
                    "}",
                ],
            ),
            file(
                "ErrorResponse",
                [
                    "import com.fasterxml.jackson.annotation.JsonInclude;",
                    "import java.util.List;",
                    "",
                    java_doc('The body of every error: {"error": {"code", "message", "details"}}.'),
                    "public record ErrorResponse(Body error) {",
                    "",
                    "    public record Body(String code, String message, @JsonInclude(JsonInclude.Include.NON_EMPTY) List<Detail> details) {",
                    "    }",
                    "",
                    "    /** Where the request is wrong and why. */",
                    "    public record Detail(String field, String message) {",
                    "    }",
                    "",
                    "    public static ErrorResponse of(String code, String message, List<Detail> details) {",
                    "        return new ErrorResponse(new Body(code, message, details));",
                    "    }",
                    "}",
                ],
            ),
            file(
                "ListQuery",
                [
                    "import java.util.Map;",
                    "",
                    java_doc(
                        "What a list asks a repository for: equality filters by JSON field name, an order and a window."
                    ),
                    "public record ListQuery(Map<String, Object> filters, String sortField, boolean descending, int offset, Integer limit) {",
                    "",
                    '    /** `"-createdAt"` sorts by createdAt in descending order. */',
                    "    public static ListQuery of(Map<String, Object> filters, String sort, int offset, Integer limit) {",
                    "        if (sort == null || sort.isEmpty()) {",
                    "            return new ListQuery(filters, null, false, offset, limit);",
                    "        }",
                    '        boolean descending = sort.startsWith("-");',
                    "        return new ListQuery(filters, descending ? sort.substring(1) : sort, descending, offset, limit);",
                    "    }",
                    "}",
                ],
            ),
            file(
                "ListResult",
                [
                    "import java.util.List;",
                    "",
                    java_doc("A window of items and how many match, whatever the window."),
                    "public record ListResult<T>(List<T> items, long total) {",
                    "}",
                ],
            ),
            file(
                "PageResponse",
                [
                    "import java.util.List;",
                    "",
                    java_doc("One page of a list, as the API returns it."),
                    "public record PageResponse<T>(List<T> items, long total, int page, int size) {",
                    "}",
                ],
            ),
        ]
    )
    handler_imports = [
        line
        for line in [
            "import jakarta.validation.ConstraintViolationException;",
            "import java.util.List;",
            "import org.slf4j.Logger;",
            "import org.slf4j.LoggerFactory;",
            context.jpa and "import org.springframework.dao.DataIntegrityViolationException;",
            "import org.springframework.http.HttpStatus;",
            "import org.springframework.http.ResponseEntity;",
            "import org.springframework.http.converter.HttpMessageNotReadableException;",
            context.security and "import org.springframework.security.access.AccessDeniedException;",
            context.security and "import org.springframework.security.core.AuthenticationException;",
            "import org.springframework.web.HttpRequestMethodNotSupportedException;",
            "import org.springframework.web.bind.MethodArgumentNotValidException;",
            "import org.springframework.web.bind.annotation.ExceptionHandler;",
            "import org.springframework.web.bind.annotation.RestControllerAdvice;",
            "import org.springframework.web.method.annotation.HandlerMethodValidationException;",
            "import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;",
            "import org.springframework.web.servlet.resource.NoResourceFoundException;",
        ]
        if isinstance(line, str)
    ]
    files.extend(
        [
            file(
                "GlobalExceptionHandler",
                [
                    *handler_imports,
                    "",
                    java_doc("Answers every error with the common format and the status of openapi.yaml."),
                    "@RestControllerAdvice",
                    "public class GlobalExceptionHandler {",
                    "",
                    "    private static final Logger LOG = LoggerFactory.getLogger(GlobalExceptionHandler.class);",
                    "",
                    "    private static ResponseEntity<ErrorResponse> answer(HttpStatus status, String code, String message, List<ErrorResponse.Detail> details) {",
                    "        return ResponseEntity.status(status).body(ErrorResponse.of(code, message, details));",
                    "    }",
                    "",
                    "    @ExceptionHandler(ApiException.class)",
                    "    ResponseEntity<ErrorResponse> api(ApiException error) {",
                    "        return answer(error.getStatus(), error.getCode(), error.getMessage(), error.getDetails());",
                    "    }",
                    "",
                    "    @ExceptionHandler(MethodArgumentNotValidException.class)",
                    "    ResponseEntity<ErrorResponse> invalidBody(MethodArgumentNotValidException error) {",
                    "        List<ErrorResponse.Detail> details = error.getBindingResult().getFieldErrors().stream()",
                    "                .map(item -> new ErrorResponse.Detail(item.getField(), item.getDefaultMessage()))",
                    "                .toList();",
                    '        return answer(HttpStatus.BAD_REQUEST, "validation_error", "The request is not valid", details);',
                    "    }",
                    "",
                    "    @ExceptionHandler({HandlerMethodValidationException.class, ConstraintViolationException.class, MethodArgumentTypeMismatchException.class})",
                    "    ResponseEntity<ErrorResponse> invalidParameter(Exception error) {",
                    '        return answer(HttpStatus.BAD_REQUEST, "validation_error", "The request is not valid", List.of());',
                    "    }",
                    "",
                    "    @ExceptionHandler(HttpMessageNotReadableException.class)",
                    "    ResponseEntity<ErrorResponse> unreadable(HttpMessageNotReadableException error) {",
                    '        return answer(HttpStatus.BAD_REQUEST, "validation_error", "The body is not valid JSON, has a value of the wrong type or an unknown field", List.of());',
                    "    }",
                    "",
                    "    @ExceptionHandler(NoResourceFoundException.class)",
                    "    ResponseEntity<ErrorResponse> noRoute(NoResourceFoundException error) {",
                    '        return answer(HttpStatus.NOT_FOUND, "not_found", "No route matches this request", List.of());',
                    "    }",
                    "",
                    "    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)",
                    "    ResponseEntity<ErrorResponse> wrongMethod(HttpRequestMethodNotSupportedException error) {",
                    f'        return answer(HttpStatus.METHOD_NOT_ALLOWED, "{GENERAL_ERROR_CODES[0]}", "This path does not accept this method", List.of());',
                    "    }",
                    "",
                    "    @ExceptionHandler(NotImplementedException.class)",
                    "    ResponseEntity<ErrorResponse> notImplemented(NotImplementedException error) {",
                    '        return answer(HttpStatus.NOT_IMPLEMENTED, "not_implemented", error.getMessage(), List.of());',
                    "    }",
                    context.jpa
                    and [
                        "",
                        "    @ExceptionHandler(DataIntegrityViolationException.class)",
                        "    ResponseEntity<ErrorResponse> integrity(DataIntegrityViolationException error) {",
                        "        // A key already used, or an item other items still refer to. The cause stays in the log",
                        '        LOG.warn("Integrity error: {}", error.getMostSpecificCause().getMessage());',
                        '        return answer(HttpStatus.CONFLICT, "conflict", "The change conflicts with the stored data", List.of());',
                        "    }",
                    ],
                    "",
                    "    @ExceptionHandler(Exception.class)",
                    "    ResponseEntity<ErrorResponse> unexpected(Exception error) throws Exception {",
                    context.security
                    and [
                        "        // Spring Security answers these itself, with 401 or 403",
                        "        if (error instanceof AccessDeniedException || error instanceof AuthenticationException) {",
                        "            throw error;",
                        "        }",
                    ],
                    '        LOG.error("Unexpected error", error);',
                    f'        return answer(HttpStatus.INTERNAL_SERVER_ERROR, "{GENERAL_ERROR_CODES[1]}", "Something went wrong on the server", List.of());',
                    "    }",
                    "}",
                ],
            ),
        ]
    )
    return files


def security_files(context: SpringContext) -> list[dict]:
    if not context.security:
        return []
    package = f"{context.base}.config"
    common = common_package(context)
    jwt = context.settings["auth"] == "jwt"
    files: list[dict] = []
    if not jwt:
        content = lines(
            f"package {package};",
            "",
            "import jakarta.servlet.FilterChain;",
            "import jakarta.servlet.ServletException;",
            "import jakarta.servlet.http.HttpServletRequest;",
            "import jakarta.servlet.http.HttpServletResponse;",
            "import java.io.IOException;",
            "import java.nio.charset.StandardCharsets;",
            "import java.security.MessageDigest;",
            "import java.util.Arrays;",
            "import java.util.List;",
            "import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;",
            "import org.springframework.security.core.context.SecurityContextHolder;",
            "import org.springframework.web.filter.OncePerRequestFilter;",
            "",
            java_doc(
                "API key authentication: a request with one of the keys in API_KEYS (header X-API-Key) is authenticated.\nWithout API_KEYS, no request is.",
            ),
            "public class ApiKeyFilter extends OncePerRequestFilter {",
            "",
            "    private final List<String> keys;",
            "",
            "    public ApiKeyFilter(String keys) {",
            '        this.keys = Arrays.stream(keys.split(",")).map(String::trim).filter(key -> !key.isEmpty()).toList();',
            "    }",
            "",
            "    /** Compares in constant time, so the answer time says nothing about the key. */",
            "    private static boolean same(String a, String b) {",
            "        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));",
            "    }",
            "",
            "    @Override",
            "    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {",
            '        String key = request.getHeader("X-API-Key");',
            "        if (key != null && keys.stream().anyMatch(valid -> same(key, valid))) {",
            '            SecurityContextHolder.getContext().setAuthentication(UsernamePasswordAuthenticationToken.authenticated("api-key", null, List.of()));',
            "        }",
            "        chain.doFilter(request, response);",
            "    }",
            "}",
        )
        files.append({"path": source_path(package, "ApiKeyFilter"), "content": file_text(content)})
    if jwt:
        documentation = (
            "Bearer token authentication. Tokens are issued by your identity provider; this API only verifies them with\n"
            'JWT_SECRET (and JWT_AUDIENCE / JWT_ISSUER when set), requires an expiry and reads the roles from the "roles"\n'
            "claim. Each endpoint says who may call it with @PreAuthorize."
        )
        chain = ", JwtDecoder decoder"
        server = [
            "                .oauth2ResourceServer(server -> server",
            '                        .authenticationEntryPoint((request, response, error) -> write(response, 401, "unauthorized", "Missing or invalid credentials"))',
            "                        .jwt(token -> token.decoder(decoder).jwtAuthenticationConverter(roles())));",
        ]
    else:
        documentation = (
            "API key authentication (see ApiKeyFilter). Each endpoint says who may call it with @PreAuthorize."
        )
        chain = ', @Value("${app.api-keys:}") String keys'
        server = "                .addFilterBefore(new ApiKeyFilter(keys), AnonymousAuthenticationFilter.class);"
    config = lines(
        f"package {package};",
        "",
        f"import {common}.ErrorResponse;",
        jwt and "import java.nio.charset.StandardCharsets;",
        "import java.util.List;",
        jwt and "import javax.crypto.spec.SecretKeySpec;",
        "import org.springframework.beans.factory.annotation.Value;",
        "import org.springframework.context.annotation.Bean;",
        "import org.springframework.context.annotation.Configuration;",
        "import org.springframework.http.MediaType;",
        "import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;",
        "import org.springframework.security.config.annotation.web.builders.HttpSecurity;",
        "import org.springframework.security.config.http.SessionCreationPolicy;",
        jwt
        and [
            "import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;",
            "import org.springframework.security.oauth2.core.OAuth2Error;",
            "import org.springframework.security.oauth2.core.OAuth2TokenValidator;",
            "import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;",
            "import org.springframework.security.oauth2.jose.jws.MacAlgorithm;",
            "import org.springframework.security.oauth2.jwt.BadJwtException;",
            "import org.springframework.security.oauth2.jwt.Jwt;",
            "import org.springframework.security.oauth2.jwt.JwtClaimValidator;",
            "import org.springframework.security.oauth2.jwt.JwtDecoder;",
            "import org.springframework.security.oauth2.jwt.JwtValidators;",
            "import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;",
            "import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationConverter;",
            "import org.springframework.security.oauth2.server.resource.authentication.JwtGrantedAuthoritiesConverter;",
        ],
        not jwt and "import org.springframework.security.web.authentication.AnonymousAuthenticationFilter;",
        "import org.springframework.security.web.SecurityFilterChain;",
        "import tools.jackson.databind.json.JsonMapper;",
        "",
        java_doc(documentation),
        "@Configuration",
        "@EnableMethodSecurity",
        "public class SecurityConfig {",
        "",
        "    private static final JsonMapper JSON = JsonMapper.builder().build();",
        "",
        "    @Bean",
        "    SecurityFilterChain securityFilterChain(HttpSecurity http" + chain + ") throws Exception {",
        "        http.csrf(csrf -> csrf.disable())",
        "                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))",
        "                // Every route is reachable; @PreAuthorize on each endpoint decides who may call it",
        "                .authorizeHttpRequests(requests -> requests.anyRequest().permitAll())",
        "                .exceptionHandling(errors -> errors",
        '                        .authenticationEntryPoint((request, response, error) -> write(response, 401, "unauthorized", "Missing or invalid credentials"))',
        '                        .accessDeniedHandler((request, response, error) -> write(response, 403, "forbidden", "The credentials do not allow this operation")))',
        server,
        "        return http.build();",
        "    }",
        jwt
        and [
            "",
            '    /** Roles from the "roles" claim, as ROLE_<name> authorities for hasAnyRole(...). */',
            "    private static JwtAuthenticationConverter roles() {",
            "        JwtGrantedAuthoritiesConverter authorities = new JwtGrantedAuthoritiesConverter();",
            '        authorities.setAuthoritiesClaimName("roles");',
            '        authorities.setAuthorityPrefix("ROLE_");',
            "        JwtAuthenticationConverter converter = new JwtAuthenticationConverter();",
            "        converter.setJwtGrantedAuthoritiesConverter(authorities);",
            "        return converter;",
            "    }",
            "",
            "    /** Verifies signature, expiry (required), and audience and issuer when they are configured. Without JWT_SECRET,",
            "     * every token is rejected. */",
            "    @Bean",
            '    JwtDecoder jwtDecoder(@Value("${app.jwt.secret:}") String secret, @Value("${app.jwt.audience:}") String audience,',
            '            @Value("${app.jwt.issuer:}") String issuer) {',
            "        if (secret.isEmpty()) {",
            "            return token -> {",
            '                throw new BadJwtException("JWT_SECRET is not configured");',
            "            };",
            "        }",
            '        NimbusJwtDecoder decoder = NimbusJwtDecoder.withSecretKey(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"))',
            "                .macAlgorithm(MacAlgorithm.HS256)",
            "                .build();",
            "        OAuth2TokenValidator<Jwt> expiry = token -> token.getExpiresAt() != null",
            "                ? OAuth2TokenValidatorResult.success()",
            '                : OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "The token has no expiry", null));',
            "        List<OAuth2TokenValidator<Jwt>> validators = new java.util.ArrayList<>(List.of(issuer.isEmpty() ? JwtValidators.createDefault() : JwtValidators.createDefaultWithIssuer(issuer), expiry));",
            "        if (!audience.isEmpty()) {",
            '            validators.add(new JwtClaimValidator<List<String>>("aud", values -> values != null && values.contains(audience)));',
            "        }",
            "        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(validators));",
            "        return decoder;",
            "    }",
        ],
        "",
        "    private static void write(jakarta.servlet.http.HttpServletResponse response, int status, String code, String message) throws java.io.IOException {",
        "        response.setStatus(status);",
        "        response.setContentType(MediaType.APPLICATION_JSON_VALUE);",
        "        JSON.writeValue(response.getOutputStream(), ErrorResponse.of(code, message, List.of()));",
        "    }",
        "}",
    )
    files.append({"path": source_path(package, "SecurityConfig"), "content": file_text(config)})
    return files


def properties_files(context: SpringContext) -> list[dict]:
    database = context.settings["database"]
    auth = context.settings["auth"]
    urls = {
        "postgresql": "jdbc:postgresql://localhost:5432/api",
        "mysql": "jdbc:mysql://localhost:3306/api",
        "mariadb": "jdbc:mariadb://localhost:3306/api",
    }
    shared = [
        "# Unknown fields in a request body are an error, as openapi.yaml describes",
        "spring.jackson.deserialization.fail-on-unknown-properties=true",
        auth == "apiKey" and ["", "# Accepted API keys, separated by commas (environment variable API_KEYS)"],
        auth == "jwt"
        and [
            "",
            "# Secret, audience and issuer of the tokens (environment variables JWT_SECRET, JWT_AUDIENCE, JWT_ISSUER)",
        ],
    ]
    url = urls[database or "postgresql"]
    main = lines(
        f"spring.application.name={context.settings['name']}",
        "server.port=${PORT:8080}",
        "",
        shared,
        auth == "apiKey" and "app.api-keys=${API_KEYS:}",
        auth == "jwt"
        and ["app.jwt.secret=${JWT_SECRET:}", "app.jwt.audience=${JWT_AUDIENCE:}", "app.jwt.issuer=${JWT_ISSUER:}"],
        context.jpa
        and [
            "",
            "# Database connection (environment variables DATABASE_URL, DATABASE_USER, DATABASE_PASSWORD)",
            "spring.datasource.url=${DATABASE_URL:" + url + "}",
            "spring.datasource.username=${DATABASE_USER:api}",
            "spring.datasource.password=${DATABASE_PASSWORD:}",
            "# Creates missing tables while you develop; use migrations for a real database (Model2DB writes them)",
            "spring.jpa.hibernate.ddl-auto=update",
            "spring.jpa.open-in-view=false",
            "# Date-times are stored in UTC, so they read back the same on any server",
            "spring.jpa.properties.hibernate.timezone.default_storage=NORMALIZE_UTC",
            '# Column names that are reserved words in some database (MySQL: "lines", "order"…) are quoted',
            "spring.jpa.properties.hibernate.auto_quote_keyword=true",
        ],
    )
    test = lines(
        "# Settings of the tests: they replace src/main/resources/application.properties while the tests run",
        f"spring.application.name={context.settings['name']}",
        "",
        shared,
        auth == "apiKey" and f"app.api-keys={TEST_API_KEY}",
        auth == "jwt" and [f"app.jwt.secret={TEST_JWT_SECRET}", "app.jwt.audience=", "app.jwt.issuer="],
        context.jpa
        and [
            "",
            "# An in-memory H2 database, or the database in TEST_DATABASE_URL",
            "spring.datasource.url=${TEST_DATABASE_URL:jdbc:h2:mem:test;DB_CLOSE_DELAY=-1}",
            "spring.datasource.username=${TEST_DATABASE_USER:sa}",
            "spring.datasource.password=${TEST_DATABASE_PASSWORD:}",
            "spring.jpa.hibernate.ddl-auto=create-drop",
            "spring.jpa.open-in-view=false",
            "spring.jpa.properties.hibernate.timezone.default_storage=NORMALIZE_UTC",
            '# Column names that are reserved words in some database (MySQL: "lines", "order"…) are quoted',
            "spring.jpa.properties.hibernate.auto_quote_keyword=true",
        ],
    )
    return [
        {"path": "src/main/resources/application.properties", "content": file_text(main)},
        {"path": "src/test/resources/application.properties", "content": file_text(test)},
    ]
