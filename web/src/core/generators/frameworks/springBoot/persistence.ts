/**
 * Storage of each resource in the Spring Boot project: the repository interface the service depends on,
 * and the implementation of the chosen persistence:
 * - `memory`: a map, to run the API without a database
 * - `none`: every method throws "not implemented" (501), with a TODO where the storage goes
 * - `jpa`: a Spring Data JPA repository behind the same interface
 */
import type { SpecResource } from '../../../api/spec.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { JavaImports, getter, javaDoc, javaString, setter } from '../../languages/java/java.ts'
import { commonPackage, keyField, keyType, names, property, sourcePath, type SpringContext } from './context.ts'

export function repositoryFiles(context: SpringContext, resource: SpecResource): GeneratedFile[] {
  const pkg = context.layout.resource(resource, 'repository')
  const name = names(resource)
  const common = commonPackage(context)
  const model = `${context.layout.resource(resource, 'model')}.${name.type}`
  const key = keyType(resource)
  const keyProperty = property(keyField(resource))
  const header = (imports: JavaImports) => [`package ${pkg};`, '', imports.render(), '']
  const files: GeneratedFile[] = []

  const contractImports = new JavaImports(pkg).add('java.util.Optional', model, `${common}.ListQuery`, `${common}.ListResult`)
  if (key === 'UUID') contractImports.add('java.util.UUID')
  files.push({
    path: sourcePath(pkg, name.repository),
    content: fileText(
      lines(
        ...header(contractImports),
        javaDoc(`Where ${resource.plural} are kept. The service depends only on this interface.`),
        `public interface ${name.repository} {`,
        '',
        '    /** Items equal to every filter, in order, within the window; and how many match. */',
        `    ListResult<${name.type}> list(ListQuery query);`,
        '',
        '    /** The item with this key, if there is one. */',
        `    Optional<${name.type}> get(${key} key);`,
        '',
        `    /** Stores a new item${resource.key.generated ? ' and assigns its key' : ''}; returns it as stored. */`,
        `    ${name.type} add(${name.type} item);`,
        '',
        '    /** Stores the new state of an existing item and returns it. */',
        `    ${name.type} update(${name.type} item);`,
        '',
        '    /** Removes an existing item. */',
        `    void delete(${key} key);`,
        '}',
      ),
    ),
  })

  if (context.pending) {
    const imports = new JavaImports(pkg).add(
      'java.util.Optional',
      model,
      `${common}.ListQuery`,
      `${common}.ListResult`,
      `${common}.NotImplementedException`,
      'org.springframework.stereotype.Repository',
    )
    if (key === 'UUID') imports.add('java.util.UUID')
    const message = javaString(`The storage of ${resource.plural} is not written yet`)
    const method = (signature: string) => [
      '    @Override',
      `    public ${signature} {`,
      `        // TODO: store ${resource.plural} in your database`,
      `        throw new NotImplementedException(${message});`,
      '    }',
    ]
    files.push({
      path: sourcePath(pkg, name.pendingRepository),
      content: fileText(
        lines(
          ...header(imports),
          javaDoc(`Storage of ${resource.plural} to write: every method answers 501 until it is implemented.`),
          '@Repository',
          `public class ${name.pendingRepository} implements ${name.repository} {`,
          '',
          method(`ListResult<${name.type}> list(ListQuery query)`),
          '',
          method(`Optional<${name.type}> get(${key} key)`),
          '',
          method(`${name.type} add(${name.type} item)`),
          '',
          method(`${name.type} update(${name.type} item)`),
          '',
          method(`void delete(${key} key)`),
          '}',
        ),
      ),
    })
    return files
  }

  if (!context.jpa) {
    const imports = new JavaImports(pkg).add(
      'java.util.ArrayList',
      'java.util.Comparator',
      'java.util.List',
      'java.util.Map',
      'java.util.Objects',
      'java.util.Optional',
      'java.util.concurrent.ConcurrentHashMap',
      model,
      `${common}.ListQuery`,
      `${common}.ListResult`,
      'org.springframework.stereotype.Repository',
    )
    if (resource.key.generated === 'increment') imports.add('java.util.concurrent.atomic.AtomicLong')
    if (key === 'UUID' || resource.key.generated === 'uuid') imports.add('java.util.UUID')
    const fieldValues = resource.fields.map((field) => `            case ${javaString(field.wire)} -> item.${getter(property(field))}();`)
    const assign =
      resource.key.generated === 'increment'
        ? [`        item.${setter(keyProperty)}(nextKey.getAndIncrement());`]
        : resource.key.generated === 'uuid'
          ? [`        item.${setter(keyProperty)}(${key === 'UUID' ? 'UUID.randomUUID()' : 'UUID.randomUUID().toString()'});`]
          : []
    files.push({
      path: sourcePath(pkg, name.memory),
      content: fileText(
        lines(
          ...header(imports),
          javaDoc(`Keeps ${resource.plural} in memory: they are lost when the application stops. Use it to try the API.`),
          '@Repository',
          `public class ${name.memory} implements ${name.repository} {`,
          '',
          `    private final Map<${key}, ${name.type}> items = new ConcurrentHashMap<>();`,
          resource.key.generated === 'increment' && '    private final AtomicLong nextKey = new AtomicLong(1);',
          '',
          '    /** The value of a field by its JSON name, for filters and sorting. */',
          `    private static Object value(${name.type} item, String field) {`,
          '        return switch (field) {',
          fieldValues,
          '            default -> null;',
          '        };',
          '    }',
          '',
          '    @SuppressWarnings({"unchecked", "rawtypes"})',
          '    @Override',
          `    public ListResult<${name.type}> list(ListQuery query) {`,
          `        List<${name.type}> found = new ArrayList<>(items.values().stream()`,
          '                .filter(item -> query.filters().entrySet().stream().allMatch(filter -> Objects.equals(value(item, filter.getKey()), filter.getValue())))',
          '                .toList());',
          '        if (query.sortField() != null) {',
          `            Comparator<${name.type}> order = Comparator.comparing(item -> (Comparable) value(item, query.sortField()));`,
          `            List<${name.type}> sorted = new ArrayList<>(found.stream().filter(item -> value(item, query.sortField()) != null).toList());`,
          '            sorted.sort(query.descending() ? order.reversed() : order);',
          '            // Items without a value go last, whatever the order',
          '            sorted.addAll(found.stream().filter(item -> value(item, query.sortField()) == null).toList());',
          '            found = sorted;',
          '        }',
          '        int from = Math.min(query.offset(), found.size());',
          '        int to = query.limit() == null ? found.size() : Math.min(from + query.limit(), found.size());',
          '        return new ListResult<>(found.subList(from, to), found.size());',
          '    }',
          '',
          '    @Override',
          `    public Optional<${name.type}> get(${key} key) {`,
          '        return Optional.ofNullable(items.get(key));',
          '    }',
          '',
          '    @Override',
          `    public ${name.type} add(${name.type} item) {`,
          assign,
          `        items.put(item.${getter(keyProperty)}(), item);`,
          '        return item;',
          '    }',
          '',
          '    @Override',
          `    public ${name.type} update(${name.type} item) {`,
          `        items.put(item.${getter(keyProperty)}(), item);`,
          '        return item;',
          '    }',
          '',
          '    @Override',
          `    public void delete(${key} key) {`,
          '        items.remove(key);',
          '    }',
          '}',
        ),
      ),
    })
    return files
  }

  // JPA: Spring Data does the work; the adapter keeps the service independent of it
  const dataImports = new JavaImports(pkg).add(
    model,
    'org.springframework.data.jpa.repository.JpaRepository',
    'org.springframework.data.jpa.repository.JpaSpecificationExecutor',
  )
  if (key === 'UUID') dataImports.add('java.util.UUID')
  files.push({
    path: sourcePath(pkg, name.springData),
    content: fileText(
      lines(
        ...header(dataImports),
        javaDoc(`Spring Data access to the ${resource.plural} table.`),
        `public interface ${name.springData} extends JpaRepository<${name.type}, ${key}>, JpaSpecificationExecutor<${name.type}> {`,
        '}',
      ),
    ),
  })
  const sortable = resource.fields.map((field) => `            case ${javaString(field.wire)} -> ${javaString(property(field))};`)
  const imports = new JavaImports(pkg).add(
    'java.util.Optional',
    model,
    `${common}.ListQuery`,
    `${common}.ListResult`,
    'org.springframework.data.domain.Page',
    'org.springframework.data.domain.PageRequest',
    'org.springframework.data.domain.Pageable',
    'org.springframework.data.domain.Sort',
    'org.springframework.data.jpa.domain.Specification',
    'org.springframework.stereotype.Repository',
  )
  if (key === 'UUID') imports.add('java.util.UUID')
  files.push({
    path: sourcePath(pkg, name.jpaRepository),
    content: fileText(
      lines(
        ...header(imports),
        javaDoc(`Keeps ${resource.plural} in the database with JPA.`),
        '@Repository',
        `public class ${name.jpaRepository} implements ${name.repository} {`,
        '',
        `    private final ${name.springData} data;`,
        '',
        `    public ${name.jpaRepository}(${name.springData} data) {`,
        '        this.data = data;',
        '    }',
        '',
        '    /** The Java property of a JSON field name. */',
        '    private static String property(String field) {',
        '        return switch (field) {',
        sortable,
        '            default -> field;',
        '        };',
        '    }',
        '',
        '    @Override',
        `    public ListResult<${name.type}> list(ListQuery query) {`,
        `        Specification<${name.type}> filters = (root, criteria, builder) -> builder.and(query.filters().entrySet().stream()`,
        '                .map(filter -> builder.equal(root.get(property(filter.getKey())), filter.getValue()))',
        '                .toArray(jakarta.persistence.criteria.Predicate[]::new));',
        `        Sort sort = query.sortField() == null ? Sort.by(${javaString(keyProperty)})`,
        `                : Sort.by(query.descending() ? Sort.Direction.DESC : Sort.Direction.ASC, property(query.sortField())).and(Sort.by(${javaString(keyProperty)}));`,
        '        if (query.limit() == null) {',
        '            var items = data.findAll(filters, sort);',
        '            return new ListResult<>(items, items.size());',
        '        }',
        '        // Offsets are always whole pages of `limit` items',
        '        Pageable page = PageRequest.of(query.offset() / query.limit(), query.limit(), sort);',
        `        Page<${name.type}> found = data.findAll(filters, page);`,
        '        return new ListResult<>(found.getContent(), found.getTotalElements());',
        '    }',
        '',
        '    @Override',
        `    public Optional<${name.type}> get(${key} key) {`,
        '        return data.findById(key);',
        '    }',
        '',
        '    @Override',
        `    public ${name.type} add(${name.type} item) {`,
        '        return data.saveAndFlush(item);',
        '    }',
        '',
        '    @Override',
        `    public ${name.type} update(${name.type} item) {`,
        '        return data.saveAndFlush(item);',
        '    }',
        '',
        '    @Override',
        `    public void delete(${key} key) {`,
        '        data.deleteById(key);',
        '        data.flush();',
        '    }',
        '}',
      ),
    ),
  })
  return files
}
