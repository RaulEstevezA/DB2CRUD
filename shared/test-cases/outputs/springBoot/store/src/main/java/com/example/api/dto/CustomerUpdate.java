package com.example.api.dto;

import com.example.api.common.Payload;
import com.example.api.model.Address;
import jakarta.validation.Valid;

/** Body of a request that changes part of a customer: only the fields sent change. */
public class CustomerUpdate extends Payload {

    private String name;

    private String email;

    private String password;

    private String phone;

    @Valid
    private Address address;

    public String getName() {
        return name;
    }

    public void setName(String name) {
        mark("name");
        this.name = name;
    }

    public String getEmail() {
        return email;
    }

    public void setEmail(String email) {
        mark("email");
        this.email = email;
    }

    public String getPassword() {
        return password;
    }

    public void setPassword(String password) {
        mark("password");
        this.password = password;
    }

    public String getPhone() {
        return phone;
    }

    public void setPhone(String phone) {
        mark("phone");
        this.phone = phone;
    }

    public Address getAddress() {
        return address;
    }

    public void setAddress(Address address) {
        mark("address");
        this.address = address;
    }
}
