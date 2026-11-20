<?php

namespace App\Entity;

use Doctrine\DBAL\Types\Types;
use Doctrine\ORM\Mapping as ORM;

/** Entity written by Model2DB from Item. Review it before using it. */
#[ORM\Entity]
#[ORM\Table(name: 'items')]
#[ORM\Index(name: 'ix_items_category_id', columns: ['category_id'])]
class Item
{
    #[ORM\Id]
    #[ORM\GeneratedValue(strategy: 'IDENTITY')]
    #[ORM\Column(name: 'id', type: Types::BIGINT)]
    private ?int $id = null;

    #[ORM\Column(name: 'name', type: Types::STRING, length: 120)]
    private string $name;

    #[ORM\Column(name: 'price', type: Types::DECIMAL, precision: 18, scale: 2)]
    private string $price;

    #[ORM\Column(name: 'supplier_email', type: Types::STRING, length: 255)]
    private string $supplierEmail;

    #[ORM\Column(name: 'stock', type: Types::INTEGER)]
    private int $stock;

    #[ORM\ManyToOne(targetEntity: Category::class)]
    #[ORM\JoinColumn(name: 'category_id', referencedColumnName: 'id', nullable: false)]
    private Category $category;

    public function getId(): ?int
    {
        return $this->id;
    }

    public function setId(?int $id): static
    {
        $this->id = $id;

        return $this;
    }

    public function getName(): string
    {
        return $this->name;
    }

    public function setName(string $name): static
    {
        $this->name = $name;

        return $this;
    }

    public function getPrice(): string
    {
        return $this->price;
    }

    public function setPrice(string $price): static
    {
        $this->price = $price;

        return $this;
    }

    public function getSupplierEmail(): string
    {
        return $this->supplierEmail;
    }

    public function setSupplierEmail(string $supplierEmail): static
    {
        $this->supplierEmail = $supplierEmail;

        return $this;
    }

    public function getStock(): int
    {
        return $this->stock;
    }

    public function setStock(int $stock): static
    {
        $this->stock = $stock;

        return $this;
    }

    public function getCategory(): Category
    {
        return $this->category;
    }

    public function setCategory(Category $category): static
    {
        $this->category = $category;

        return $this;
    }
}
