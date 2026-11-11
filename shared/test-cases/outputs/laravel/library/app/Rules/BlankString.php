<?php

namespace App\Rules;

use Closure;
use Illuminate\Contracts\Validation\ValidationRule;

/**
 * Laravel skips its rules when a value is an empty or blank text ("", "  "). This rule checks those texts
 * against what the field declares: whether it is a text at all, its length, its pattern and its format.
 */
final class BlankString implements ValidationRule
{
    /** Runs even for blank values, which is all it is for */
    public bool $implicit = true;

    public function __construct(
        private readonly bool $text,
        private readonly ?int $min = null,
        private readonly ?int $max = null,
        private readonly ?string $pattern = null,
        private readonly bool $format = false,
    ) {
    }

    public function validate(string $attribute, mixed $value, Closure $fail): void
    {
        if (! is_string($value) || trim($value) !== '') {
            return;
        }
        $length = mb_strlen($value);
        if (! $this->text) {
            $fail('The :attribute field has the wrong type.');
        } elseif ($this->format) {
            $fail('The :attribute field must not be blank.');
        } elseif ($this->min !== null && $length < $this->min) {
            $fail("The :attribute field must be at least {$this->min} characters.");
        } elseif ($this->max !== null && $length > $this->max) {
            $fail("The :attribute field must not be greater than {$this->max} characters.");
        } elseif ($this->pattern !== null && preg_match($this->pattern, $value) !== 1) {
            $fail('The :attribute field format is invalid.');
        }
    }
}
