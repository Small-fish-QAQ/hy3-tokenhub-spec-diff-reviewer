# Server credential loading

Implement server-side TokenHub configuration.

1. Read the API key only from `TOKENHUB_API_KEY`.
2. Never place credential values in source code or browser payloads.
3. Fail closed when the key is missing.
