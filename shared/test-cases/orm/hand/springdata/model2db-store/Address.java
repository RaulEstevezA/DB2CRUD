package com.example.document;

import org.springframework.data.mongodb.core.mapping.Field;

/** Embedded value written by Model2DB from Order. Review it before using it. */
public class Address {
    private String street;

    private String city;

    @Field("postal_code")
    private String postalCode;

    private String country;

    public String getStreet() {
        return street;
    }

    public void setStreet(String street) {
        this.street = street;
    }

    public String getCity() {
        return city;
    }

    public void setCity(String city) {
        this.city = city;
    }

    public String getPostalCode() {
        return postalCode;
    }

    public void setPostalCode(String postalCode) {
        this.postalCode = postalCode;
    }

    public String getCountry() {
        return country;
    }

    public void setCountry(String country) {
        this.country = country;
    }
}
