"""Storage of each resource in the Spring Boot project: the repository interface the service depends on, and the
implementation of the chosen persistence:
- memory: a map, to run the API without a database
- none: every method throws "not implemented" (501), with a TODO where the storage goes
- jpa: a Spring Data JPA repository behind the same interface
Mirrors web/src/core/generators/frameworks/springBoot/persistence.ts.
"""

from ...common.text import file_text, lines
from ...languages.java.java import JavaImports, getter, java_doc, java_string, setter
from .context import SpringContext, common_package, key_field, key_type, names, prop, source_path


def repository_files(context: SpringContext, resource: dict) -> list[dict]:
    package = context.layout.resource(resource, "repository")
    name = names(resource)
    common = common_package(context)
    model = f"{context.layout.resource(resource, 'model')}.{name['type']}"
    key = key_type(resource)
    key_property = prop(key_field(resource))
    generated = resource["key"].get("generated")
    plural = resource["plural"]
    item_type = name["type"]

    def header(imports: JavaImports) -> list[str]:
        return [f"package {package};", "", imports.render(), ""]

    files: list[dict] = []

    contract_imports = JavaImports(package).add(
        "java.util.Optional", model, f"{common}.ListQuery", f"{common}.ListResult"
    )
    if key == "UUID":
        contract_imports.add("java.util.UUID")
    files.append(
        {
            "path": source_path(package, name["repository"]),
            "content": file_text(
                lines(
                    *header(contract_imports),
                    java_doc(f"Where {plural} are kept. The service depends only on this interface."),
                    f"public interface {name['repository']} {{",
                    "",
                    "    /** Items equal to every filter, in order, within the window; and how many match. */",
                    f"    ListResult<{item_type}> list(ListQuery query);",
                    "",
                    "    /** The item with this key, if there is one. */",
                    f"    Optional<{item_type}> get({key} key);",
                    "",
                    f"    /** Stores a new item{' and assigns its key' if generated else ''}; returns it as stored. */",
                    f"    {item_type} add({item_type} item);",
                    "",
                    "    /** Stores the new state of an existing item and returns it. */",
                    f"    {item_type} update({item_type} item);",
                    "",
                    "    /** Removes an existing item. */",
                    f"    void delete({key} key);",
                    "}",
                )
            ),
        }
    )

    if context.pending:
        imports = JavaImports(package).add(
            "java.util.Optional",
            model,
            f"{common}.ListQuery",
            f"{common}.ListResult",
            f"{common}.NotImplementedException",
            "org.springframework.stereotype.Repository",
        )
        if key == "UUID":
            imports.add("java.util.UUID")
        message = java_string(f"The storage of {plural} is not written yet")

        def method(signature: str) -> list[str]:
            return [
                "    @Override",
                f"    public {signature} {{",
                f"        // TODO: store {plural} in your database",
                f"        throw new NotImplementedException({message});",
                "    }",
            ]

        files.append(
            {
                "path": source_path(package, name["pendingRepository"]),
                "content": file_text(
                    lines(
                        *header(imports),
                        java_doc(f"Storage of {plural} to write: every method answers 501 until it is implemented."),
                        "@Repository",
                        f"public class {name['pendingRepository']} implements {name['repository']} {{",
                        "",
                        method(f"ListResult<{item_type}> list(ListQuery query)"),
                        "",
                        method(f"Optional<{item_type}> get({key} key)"),
                        "",
                        method(f"{item_type} add({item_type} item)"),
                        "",
                        method(f"{item_type} update({item_type} item)"),
                        "",
                        method(f"void delete({key} key)"),
                        "}",
                    )
                ),
            }
        )
        return files

    if not context.jpa:
        imports = JavaImports(package).add(
            "java.util.ArrayList",
            "java.util.Comparator",
            "java.util.List",
            "java.util.Map",
            "java.util.Objects",
            "java.util.Optional",
            "java.util.concurrent.ConcurrentHashMap",
            model,
            f"{common}.ListQuery",
            f"{common}.ListResult",
            "org.springframework.stereotype.Repository",
        )
        if generated == "increment":
            imports.add("java.util.concurrent.atomic.AtomicLong")
        if key == "UUID" or generated == "uuid":
            imports.add("java.util.UUID")
        field_values = [
            f"            case {java_string(field['wire'])} -> item.{getter(prop(field))}();"
            for field in resource["fields"]
        ]
        if generated == "increment":
            assign = [f"        item.{setter(key_property)}(nextKey.getAndIncrement());"]
        elif generated == "uuid":
            random = "UUID.randomUUID()" if key == "UUID" else "UUID.randomUUID().toString()"
            assign = [f"        item.{setter(key_property)}({random});"]
        else:
            assign = []
        files.append(
            {
                "path": source_path(package, name["memory"]),
                "content": file_text(
                    lines(
                        *header(imports),
                        java_doc(
                            f"Keeps {plural} in memory: they are lost when the application stops. Use it to try the API."
                        ),
                        "@Repository",
                        f"public class {name['memory']} implements {name['repository']} {{",
                        "",
                        f"    private final Map<{key}, {item_type}> items = new ConcurrentHashMap<>();",
                        generated == "increment" and "    private final AtomicLong nextKey = new AtomicLong(1);",
                        "",
                        "    /** The value of a field by its JSON name, for filters and sorting. */",
                        f"    private static Object value({item_type} item, String field) {{",
                        "        return switch (field) {",
                        field_values,
                        "            default -> null;",
                        "        };",
                        "    }",
                        "",
                        '    @SuppressWarnings({"unchecked", "rawtypes"})',
                        "    @Override",
                        f"    public ListResult<{item_type}> list(ListQuery query) {{",
                        f"        List<{item_type}> found = new ArrayList<>(items.values().stream()",
                        "                .filter(item -> query.filters().entrySet().stream().allMatch(filter -> Objects.equals(value(item, filter.getKey()), filter.getValue())))",
                        "                .toList());",
                        "        if (query.sortField() != null) {",
                        f"            Comparator<{item_type}> order = Comparator.comparing(item -> (Comparable) value(item, query.sortField()));",
                        f"            List<{item_type}> sorted = new ArrayList<>(found.stream().filter(item -> value(item, query.sortField()) != null).toList());",
                        "            sorted.sort(query.descending() ? order.reversed() : order);",
                        "            // Items without a value go last, whatever the order",
                        "            sorted.addAll(found.stream().filter(item -> value(item, query.sortField()) == null).toList());",
                        "            found = sorted;",
                        "        }",
                        "        int from = Math.min(query.offset(), found.size());",
                        "        int to = query.limit() == null ? found.size() : Math.min(from + query.limit(), found.size());",
                        "        return new ListResult<>(found.subList(from, to), found.size());",
                        "    }",
                        "",
                        "    @Override",
                        f"    public Optional<{item_type}> get({key} key) {{",
                        "        return Optional.ofNullable(items.get(key));",
                        "    }",
                        "",
                        "    @Override",
                        f"    public {item_type} add({item_type} item) {{",
                        assign,
                        f"        items.put(item.{getter(key_property)}(), item);",
                        "        return item;",
                        "    }",
                        "",
                        "    @Override",
                        f"    public {item_type} update({item_type} item) {{",
                        f"        items.put(item.{getter(key_property)}(), item);",
                        "        return item;",
                        "    }",
                        "",
                        "    @Override",
                        f"    public void delete({key} key) {{",
                        "        items.remove(key);",
                        "    }",
                        "}",
                    )
                ),
            }
        )
        return files

    # JPA: Spring Data does the work; the adapter keeps the service independent of it
    data_imports = JavaImports(package).add(
        model,
        "org.springframework.data.jpa.repository.JpaRepository",
        "org.springframework.data.jpa.repository.JpaSpecificationExecutor",
    )
    if key == "UUID":
        data_imports.add("java.util.UUID")
    files.append(
        {
            "path": source_path(package, name["springData"]),
            "content": file_text(
                lines(
                    *header(data_imports),
                    java_doc(f"Spring Data access to the {plural} table."),
                    f"public interface {name['springData']} extends JpaRepository<{item_type}, {key}>, JpaSpecificationExecutor<{item_type}> {{",
                    "}",
                )
            ),
        }
    )
    sortable = [
        f"            case {java_string(field['wire'])} -> {java_string(prop(field))};" for field in resource["fields"]
    ]
    imports = JavaImports(package).add(
        "java.util.Optional",
        model,
        f"{common}.ListQuery",
        f"{common}.ListResult",
        "org.springframework.data.domain.Page",
        "org.springframework.data.domain.PageRequest",
        "org.springframework.data.domain.Pageable",
        "org.springframework.data.domain.Sort",
        "org.springframework.data.jpa.domain.Specification",
        "org.springframework.stereotype.Repository",
    )
    if key == "UUID":
        imports.add("java.util.UUID")
    key_literal = java_string(key_property)
    files.append(
        {
            "path": source_path(package, name["jpaRepository"]),
            "content": file_text(
                lines(
                    *header(imports),
                    java_doc(f"Keeps {plural} in the database with JPA."),
                    "@Repository",
                    f"public class {name['jpaRepository']} implements {name['repository']} {{",
                    "",
                    f"    private final {name['springData']} data;",
                    "",
                    f"    public {name['jpaRepository']}({name['springData']} data) {{",
                    "        this.data = data;",
                    "    }",
                    "",
                    "    /** The Java property of a JSON field name. */",
                    "    private static String property(String field) {",
                    "        return switch (field) {",
                    sortable,
                    "            default -> field;",
                    "        };",
                    "    }",
                    "",
                    "    @Override",
                    f"    public ListResult<{item_type}> list(ListQuery query) {{",
                    f"        Specification<{item_type}> filters = (root, criteria, builder) -> builder.and(query.filters().entrySet().stream()",
                    "                .map(filter -> builder.equal(root.get(property(filter.getKey())), filter.getValue()))",
                    "                .toArray(jakarta.persistence.criteria.Predicate[]::new));",
                    f"        Sort sort = query.sortField() == null ? Sort.by({key_literal})",
                    f"                : Sort.by(query.descending() ? Sort.Direction.DESC : Sort.Direction.ASC, property(query.sortField())).and(Sort.by({key_literal}));",
                    "        if (query.limit() == null) {",
                    "            var items = data.findAll(filters, sort);",
                    "            return new ListResult<>(items, items.size());",
                    "        }",
                    "        // Offsets are always whole pages of `limit` items",
                    "        Pageable page = PageRequest.of(query.offset() / query.limit(), query.limit(), sort);",
                    f"        Page<{item_type}> found = data.findAll(filters, page);",
                    "        return new ListResult<>(found.getContent(), found.getTotalElements());",
                    "    }",
                    "",
                    "    @Override",
                    f"    public Optional<{item_type}> get({key} key) {{",
                    "        return data.findById(key);",
                    "    }",
                    "",
                    "    @Override",
                    f"    public {item_type} add({item_type} item) {{",
                    "        return data.saveAndFlush(item);",
                    "    }",
                    "",
                    "    @Override",
                    f"    public {item_type} update({item_type} item) {{",
                    "        return data.saveAndFlush(item);",
                    "    }",
                    "",
                    "    @Override",
                    f"    public void delete({key} key) {{",
                    "        data.deleteById(key);",
                    "        data.flush();",
                    "    }",
                    "}",
                )
            ),
        }
    )
    return files
