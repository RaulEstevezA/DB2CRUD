<?php

namespace App\Http;

use App\Exception\ApiException;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Validator\Constraint;
use Symfony\Component\Validator\Validator\ValidatorInterface;

/**
 * Reads the body of a request: it must be a JSON object and meet the constraints of the request, which reject
 * fields the contract does not describe (openapi.yaml, additionalProperties: false).
 */
final class JsonBody
{
    public function __construct(private readonly ValidatorInterface $validator)
    {
    }

    /** @return array<string, mixed> The body, checked */
    public function read(Request $request, Constraint $constraint): array
    {
        $content = $request->getContent();
        try {
            $body = json_decode($content === '' ? 'null' : $content, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new ApiException(400, 'validation_error', 'The body is not valid JSON');
        }
        if (! is_array($body) || (array_is_list($body) && $body !== [])) {
            throw new ApiException(400, 'validation_error', 'The body must be a JSON object');
        }
        $details = [];
        foreach ($this->validator->validate($body, $constraint) as $violation) {
            // [address][street] is address.street, as in the other answers
            $field = trim(str_replace('][', '.', $violation->getPropertyPath()), '[]');
            $details[] = ['field' => $field, 'message' => (string) $violation->getMessage()];
        }
        if ($details !== []) {
            throw new ApiException(400, 'validation_error', 'The request is not valid', $details);
        }

        return $body;
    }
}
