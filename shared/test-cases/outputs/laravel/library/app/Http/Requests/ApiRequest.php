<?php

namespace App\Http\Requests;

use App\Exceptions\ApiException;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

/**
 * Base of request bodies. The body must be a JSON object, and a field the contract does not describe is an
 * error, as in openapi.yaml (additionalProperties: false).
 */
abstract class ApiRequest extends FormRequest
{
    /**
     * Paths whose content is free (maps and values of any shape): nothing under them is checked. A "*"
     * stands for every item of a list.
     *
     * @var list<string>
     */
    protected array $open = [];

    public function authorize(): bool
    {
        return true;
    }

    protected function prepareForValidation(): void
    {
        $content = $this->getContent();
        $body = json_decode($content === '' ? 'null' : $content, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new ApiException(400, 'validation_error', 'The body is not valid JSON');
        }
        if (! is_array($body) || (array_is_list($body) && $body !== [])) {
            throw new ApiException(400, 'validation_error', 'The body must be a JSON object');
        }
    }

    public function withValidator(Validator $validator): void
    {
        $validator->after(function (Validator $validator): void {
            $known = array_keys($this->rules());
            foreach ($this->unknownPaths($this->json()->all(), '', '', $known) as $path) {
                $validator->errors()->add($path, 'This field is not part of the contract.');
            }
        });
    }

    /**
     * Paths of the input that no rule describes. $pattern is the path with "*" for list items.
     *
     * @param  list<string>  $known
     * @return list<string>
     */
    private function unknownPaths(mixed $value, string $path, string $pattern, array $known): array
    {
        if (! is_array($value) || ($pattern !== '' && in_array($pattern, $this->open, true))) {
            return [];
        }
        $unknown = [];
        foreach ($value as $key => $item) {
            $itemPath = $path === '' ? (string) $key : "{$path}.{$key}";
            $itemPattern = ($pattern === '' ? '' : "{$pattern}.").(array_is_list($value) ? '*' : (string) $key);
            if (! in_array($itemPattern, $known, true)) {
                $unknown[] = $itemPath;

                continue;
            }
            array_push($unknown, ...$this->unknownPaths($item, $itemPath, $itemPattern, $known));
        }

        return $unknown;
    }
}
