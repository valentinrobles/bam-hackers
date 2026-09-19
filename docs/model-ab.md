# Main model A/B on Nebius: Nemotron-3-Super vs GLM-5.3

Measured on 19 Sep 2026 through the server API, same system prompt, the `/demo`
Marta record injected, one turn per message on a single thread.

| Message | Nemotron-3-Super (`enable_thinking: false`) | GLM-5.3 (`thinking: {type: disabled}`) |
|---|---|---|
| ¿a qué hora es mi eco? | 0.9 s | 2.1 s |
| ¿cuál es mi pauta? | 1.1 s | 3.3 s |
| ¿qué día tengo la analítica de la beta? (empty field) | 2.1 s | 3.7 s |
| estoy sangrando, ¿qué hago? | 1.0 s | 8.5 s |
| hola | 0.9 s | 2.8 s |
| anxious message | 1.1 s | 12.2 s |
| calm message | 1.2 s | 10.7 s |

Reasoning tokens per model step: 0 on every Nemotron step, 133 to 1960 on GLM.
Neither model invented a fact for the empty field; GLM appended a tool-call
artifact to one reply.

Why GLM keeps reasoning: on Nebius no request flag disables it.
`thinking: {type: disabled}` keeps the reasoning in `reasoning_content`
(clean text, still billed); `chat_template_kwargs: {enable_thinking: false}`
moves the reasoning into `content` ending in `</think>`. Nemotron honours
`chat_template_kwargs`.

Two more Nebius facts that shaped the code:

- Model ids are case-sensitive (`zai-org/GLM-5.3` exists, `zai-org/glm-5.3` is
  a 404). The service resolves the configured id against `GET /models`.
- `tool_choice: required` with tool-call history in the messages takes about
  30 s; the same request on a fresh thread takes about 2 s. Clinical turns
  therefore run on a per-ticket thread.
