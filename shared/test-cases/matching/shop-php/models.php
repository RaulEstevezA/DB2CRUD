<?php

namespace Shop\Models;

enum ProductStatus: string
{
    case Draft = 'draft';
    case Live = 'live';
}

/** A customer of the shop */
final class Customer
{
    public function __construct(
        public int $id,
        public string $email,
        public string $passwordHash,
        public \DateTimeImmutable $createdAt,
    ) {
    }
}

final readonly class CategoryDto
{
    public function __construct(public int $id, public string $name)
    {
    }
}

class Product
{
    public int $id;
    public string $name;
    public string $price;
    public ProductStatus $status;
    public string $categoryName;
    /** @var list<int> */
    public array $tagIds = [];
}

class TagEntity
{
    private int $id;
    private string $label;

    public function getId(): int { return $this->id; }
    public function setId(int $id): void { $this->id = $id; }
    public function getLabel(): string { return $this->label; }
    public function setLabel(string $label): void { $this->label = $label; }
}
