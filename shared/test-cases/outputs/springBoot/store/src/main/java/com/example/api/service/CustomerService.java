package com.example.api.service;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;

import com.example.api.common.ApiException;
import com.example.api.common.ListQuery;
import com.example.api.common.ListResult;
import com.example.api.dto.CustomerCreate;
import com.example.api.dto.CustomerUpdate;
import com.example.api.model.Customer;
import com.example.api.repository.CustomerRepository;
import org.springframework.stereotype.Service;

/** Rules of customers: what each operation checks and changes. */
@Service
public class CustomerService {

    private final CustomerRepository repository;

    public CustomerService(CustomerRepository repository) {
        this.repository = repository;
    }

    private Customer find(Long key) {
        return repository.get(key).orElseThrow(() -> ApiException.notFound("customer"));
    }

    private static void rejectNull(boolean sent, Object value, String field) {
        if (sent && value == null) {
            throw ApiException.invalid(field, "must not be null");
        }
    }

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private void apply(Customer item, CustomerCreate data) {
        rejectNull(data.has("phone"), data.getPhone(), "phone");
        item.setName(data.getName());
        item.setEmail(data.getEmail());
        item.setPassword(data.getPassword());
        item.setPhone(data.getPhone());
        item.setAddress(data.getAddress());
    }

    private void applyChanges(Customer item, CustomerUpdate data) {
        rejectNull(data.has("name"), data.getName(), "name");
        rejectNull(data.has("email"), data.getEmail(), "email");
        rejectNull(data.has("password"), data.getPassword(), "password");
        rejectNull(data.has("phone"), data.getPhone(), "phone");
        rejectNull(data.has("address"), data.getAddress(), "address");
        if (data.has("name")) {
            item.setName(data.getName());
        }
        if (data.has("email")) {
            item.setEmail(data.getEmail());
        }
        if (data.has("password")) {
            item.setPassword(data.getPassword());
        }
        if (data.has("phone")) {
            item.setPhone(data.getPhone());
        }
        if (data.has("address")) {
            item.setAddress(data.getAddress());
        }
    }

    /** List customers. */
    public ListResult<Customer> listCustomers(ListQuery query) {
        return repository.list(query);
    }

    /** Get a customer. */
    public Customer getCustomer(Long key) {
        return find(key);
    }

    /** Create a customer. */
    public Customer createCustomer(CustomerCreate data) {
        Customer item = new Customer();
        apply(item, data);
        item.setCreatedAt(OffsetDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.MICROS));
        return repository.add(item);
    }

    /** Replace a customer: every field the client may send takes the value of the body. */
    public Customer replaceCustomer(Long key, CustomerCreate data) {
        Customer item = find(key);
        apply(item, data);
        return repository.update(item);
    }

    /** Update part of a customer: only the fields in the body change. */
    public Customer updateCustomer(Long key, CustomerUpdate data) {
        Customer item = find(key);
        applyChanges(item, data);
        return repository.update(item);
    }

    /** Delete a customer. */
    public void deleteCustomer(Long key) {
        find(key);
        repository.delete(key);
    }
}
